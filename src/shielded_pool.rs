//! Shared test-token custody and isolated BTC margin accounting.
use crate::verifier::{validate_vk, verify};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env, near,
    require,
};

type Hash = [u8; 32];
const ZERO: Hash = [0; 32];
const LEAVES: usize = if cfg!(feature = "judge-pool") { 64 } else { 16 };
const CAP: u64 = 60_000;
const SPEND_INPUTS: usize = if cfg!(feature = "browser-pool") {
    11
} else {
    19
};
const CLOSE_INPUTS: usize = if cfg!(feature = "browser-pool") {
    8
} else {
    13
};

#[near(serializers = [borsh])]
#[derive(Clone)]
struct Position {
    commitment: Hash,
    context: Hash,
    owner_tag: Hash,
}

#[near(serializers = [borsh])]
struct Exit {
    nullifiers: [Hash; 2],
    change: Hash,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ShieldedPool {
    token: AccountId,
    maker: AccountId,
    oracle: AccountId,
    domain: Hash,
    spend_vk: Vec<u8>,
    close_vk: Vec<u8>,
    leaves: Vec<Hash>,
    #[cfg(feature = "judge-pool")]
    tree: Vec<Hash>,
    spent: Vec<Hash>,
    positions: Vec<Position>,
    pending: Vec<(u32, Exit)>,
    next_exit: u32,
    maker_available: u64,
    price: u16,
    round: u64,
}

fn digest(parts: &[&[u8]]) -> Hash {
    env::sha256_array(&parts.concat())
}

fn parse(bytes: Base64VecU8) -> Hash {
    let hash = bytes
        .0
        .try_into()
        .unwrap_or_else(|_| env::panic_str("ERR_HASH_LENGTH"));
    #[cfg(feature = "browser-pool")]
    require!(crate::pool_poseidon::canonical(&hash), "ERR_FIELD_ENCODING");
    hash
}

fn b64(bytes: Hash) -> Base64VecU8 {
    Base64VecU8(bytes.to_vec())
}

fn proof_inputs(digests: &[Hash], integers: &[u64]) -> Vec<Hash> {
    let mut inputs = Vec::with_capacity(digests.len() * 2 + integers.len());
    for digest in digests {
        if cfg!(feature = "browser-pool") {
            inputs.push(*digest);
            continue;
        }
        for chunk in digest.chunks_exact(16) {
            let mut field = ZERO;
            field[..16].copy_from_slice(chunk);
            inputs.push(field);
        }
    }
    for value in integers {
        let mut field = ZERO;
        field[..8].copy_from_slice(&value.to_le_bytes());
        inputs.push(field);
    }
    inputs
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": "quiet_margin_pool", "version": "1.0.0", "event": event, "data": [data],
        })
    ));
}

#[near]
impl ShieldedPool {
    #[init]
    #[private]
    pub fn init(
        token: AccountId,
        maker: AccountId,
        oracle: AccountId,
        spend_vk: Base64VecU8,
        close_vk: Base64VecU8,
    ) -> Self {
        require!(
            validate_vk(&spend_vk.0, SPEND_INPUTS) && validate_vk(&close_vk.0, CLOSE_INPUTS),
            "ERR_KEY"
        );
        let current = env::current_account_id();
        let domain = digest(&[
            b"QM:pool-domain:2:",
            current.as_bytes(),
            b":",
            token.as_bytes(),
        ]);
        #[cfg(feature = "browser-pool")]
        let domain = crate::pool_poseidon::encode(crate::pool_poseidon::field(&domain));
        Self {
            token,
            maker,
            oracle,
            domain,
            spend_vk: spend_vk.0,
            close_vk: close_vk.0,
            leaves: vec![],
            #[cfg(feature = "judge-pool")]
            tree: Self::empty_tree(),
            spent: vec![],
            positions: vec![],
            pending: vec![],
            next_exit: 0,
            maker_available: 0,
            price: 0,
            round: 0,
        }
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "ERR_TOKEN");
        let Ok(cents) = u64::try_from(amount.0) else {
            return PromiseOrValue::Value(amount);
        };
        if cents == 0 {
            return PromiseOrValue::Value(amount);
        }
        if msg == "maker" && sender_id == self.maker {
            let Some(balance) = self.maker_available.checked_add(cents) else {
                return PromiseOrValue::Value(amount);
            };
            self.maker_available = balance;
            return PromiseOrValue::Value(U128(0));
        }
        if cents > 1_000_000 || msg.len() != 44 {
            return PromiseOrValue::Value(amount);
        }
        let Ok(inner) = serde_json::from_value::<Base64VecU8>(json!(msg)) else {
            return PromiseOrValue::Value(amount);
        };
        if inner.0.len() != 32 || serde_json::to_value(&inner).ok() != Some(json!(msg)) {
            return PromiseOrValue::Value(amount);
        }
        #[cfg(not(feature = "browser-pool"))]
        let leaf = digest(&[
            b"QM:note-leaf:2",
            &self.domain,
            &inner.0,
            &cents.to_le_bytes(),
        ]);
        #[cfg(feature = "browser-pool")]
        let leaf = {
            let inner: Hash = inner.0.try_into().expect("checked hash length");
            if !crate::pool_poseidon::canonical(&inner) {
                return PromiseOrValue::Value(amount);
            }
            crate::pool_poseidon::leaf(&self.domain, &inner, cents)
        };
        if !self.can_append(&leaf, 0) {
            return PromiseOrValue::Value(amount);
        }
        self.append(leaf);
        emit(
            "note_deposited",
            json!({"leaf": b64(leaf), "amount": amount}),
        );
        PromiseOrValue::Value(U128(0))
    }

    pub fn publish_mark(&mut self, price_ticks: u16) {
        require!(
            env::predecessor_account_id() == self.oracle && (1..=20_000).contains(&price_ticks),
            "ERR_ORACLE"
        );
        self.price = price_ticks;
        self.round = self.round.checked_add(1).expect("round overflow");
    }

    pub fn open_private(
        &mut self,
        root: Base64VecU8,
        nullifiers: [Base64VecU8; 2],
        commitment: Base64VecU8,
        context: Base64VecU8,
        owner_tag: Base64VecU8,
        change: Base64VecU8,
        entry_ticks: u16,
        proof: Base64VecU8,
    ) {
        let (position, context, tag, change) = (
            parse(commitment),
            parse(context),
            parse(owner_tag),
            parse(change),
        );
        require!(
            self.price != 0 && self.price == entry_ticks && self.maker_available >= CAP,
            "ERR_MARK_OR_RESERVE"
        );
        require!(
            position != ZERO && !self.positions.iter().any(|p| p.commitment == position),
            "ERR_POSITION"
        );
        require!(
            self.available_slots() >= 1 + usize::from(change != ZERO),
            "ERR_POOL_CAPACITY"
        );
        self.check_spend(
            parse(root),
            nullifiers.map(parse),
            position,
            change,
            context,
            tag,
            entry_ticks,
            0,
            &proof.0,
        );
        self.maker_available -= CAP;
        self.positions.push(Position {
            commitment: position,
            context,
            owner_tag: tag,
        });
        self.append(change);
        emit(
            "position_opened",
            json!({"commitment": b64(position), "mark_round": self.round, "change": b64(change)}),
        );
    }

    pub fn close_private(
        &mut self,
        commitment: Base64VecU8,
        round: u64,
        payout: Base64VecU8,
        maker_credit: U128,
        proof: Base64VecU8,
    ) {
        let commitment = parse(commitment);
        let payout = parse(payout);
        let credit = u64::try_from(maker_credit.0).expect("credit overflow");
        require!(round == self.round && round != 0, "ERR_ORACLE_ROUND");
        let index = self
            .positions
            .iter()
            .position(|p| p.commitment == commitment)
            .expect("ERR_NO_POSITION");
        let pos = &self.positions[index];
        require!(payout == ZERO || self.can_append(&payout, 1), "ERR_CHANGE");
        let inputs = proof_inputs(
            &[commitment, pos.context, self.domain, pos.owner_tag, payout],
            &[u64::from(self.price), round, credit],
        );
        require!(
            verify(&self.close_vk, &proof.0, &inputs),
            "ERR_PROOF_INVALID"
        );
        self.maker_available = self
            .maker_available
            .checked_add(credit)
            .expect("maker overflow");
        self.positions.swap_remove(index);
        self.append(payout);
        emit(
            "position_closed",
            json!({"commitment": b64(commitment), "payout_note": b64(payout), "round": round, "maker_credit": maker_credit}),
        );
    }

    #[payable]
    pub fn withdraw_private(
        &mut self,
        root: Base64VecU8,
        nullifiers: [Base64VecU8; 2],
        recipient: AccountId,
        amount: U128,
        change: Base64VecU8,
        proof: Base64VecU8,
    ) -> Promise {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "ERR_ONE_YOCTO"
        );
        require!(env::prepaid_gas() >= Gas::from_tgas(90), "ERR_GAS");
        let cents = u64::try_from(amount.0).expect("amount overflow");
        require!(cents > 0, "ERR_ZERO");
        let n = nullifiers.map(parse);
        let change = parse(change);
        let to = digest(&[b"QM:exit:2:", recipient.as_bytes()]);
        #[cfg(feature = "browser-pool")]
        let to = crate::pool_poseidon::encode(crate::pool_poseidon::field(&to));
        self.check_spend(parse(root), n, to, change, ZERO, ZERO, 0, cents, &proof.0);
        let id = self.next_exit;
        self.next_exit = id.checked_add(1).expect("exit overflow");
        self.pending.push((
            id,
            Exit {
                nullifiers: n,
                change,
            },
        ));
        Promise::new(self.token.clone())
            .function_call(
                "ft_transfer",
                serde_json::to_vec(&json!({"receiver_id": recipient, "amount": amount})).unwrap(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(18),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(22))
                    .resolve_exit(id),
            )
    }

    #[private]
    pub fn resolve_exit(
        &mut self,
        id: u32,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let index = self
            .pending
            .iter()
            .position(|(key, _)| *key == id)
            .expect("ERR_EXIT");
        let (_, exit) = self.pending.swap_remove(index);
        if result.is_ok() {
            self.append(exit.change);
            emit("withdrawn", json!({"id": id, "change": b64(exit.change)}));
            true
        } else {
            self.spent.retain(|n| !exit.nullifiers.contains(n));
            emit("withdrawal_restored", json!({"id": id}));
            false
        }
    }

    pub fn get_pool(&self) -> serde_json::Value {
        json!({
            "proof_version": if cfg!(feature = "judge-pool") { "poseidon-v2" } else if cfg!(feature = "browser-pool") { "poseidon-v1" } else { "sha256-v2" },
            "capacity": LEAVES,
            "domain": b64(self.domain), "token": self.token, "root": b64(self.root()),
            "leaves": self.leaves.iter().copied().map(b64).collect::<Vec<_>>(),
            "spent": self.spent.iter().copied().map(b64).collect::<Vec<_>>(),
            "positions": self.positions.iter().map(|p| b64(p.commitment)).collect::<Vec<_>>(),
            "pending": self.pending.len(), "price_ticks": self.price, "round": self.round,
            "maker_available": U128(u128::from(self.maker_available)),
            "spend_vk_sha256": b64(env::sha256_array(&self.spend_vk)),
            "close_vk_sha256": b64(env::sha256_array(&self.close_vk)),
        })
    }
}

impl ShieldedPool {
    fn available_slots(&self) -> usize {
        LEAVES
            - self.leaves.len()
            - self.positions.len()
            - self
                .pending
                .iter()
                .filter(|(_, e)| e.change != ZERO)
                .count()
    }

    fn can_append(&self, leaf: &Hash, reserved_slots: usize) -> bool {
        *leaf != ZERO
            && self.available_slots() + reserved_slots > 0
            && !self.leaves.contains(leaf)
            && !self.pending.iter().any(|(_, e)| &e.change == leaf)
    }

    fn append(&mut self, leaf: Hash) {
        if leaf != ZERO {
            #[cfg(feature = "judge-pool")]
            {
                let mut index = LEAVES + self.leaves.len();
                self.tree[index] = leaf;
                while index > 1 {
                    index /= 2;
                    self.tree[index] = crate::pool_poseidon::branch(
                        &self.tree[index * 2],
                        &self.tree[index * 2 + 1],
                    );
                }
            }
            self.leaves.push(leaf);
        }
    }

    #[cfg(feature = "judge-pool")]
    fn empty_tree() -> Vec<Hash> {
        let mut tree = vec![ZERO; LEAVES * 2];
        let mut width = LEAVES;
        let mut hash = ZERO;
        while width > 1 {
            hash = crate::pool_poseidon::branch(&hash, &hash);
            tree[width / 2..width].fill(hash);
            width /= 2;
        }
        tree
    }

    #[cfg(feature = "judge-pool")]
    fn root(&self) -> Hash {
        self.tree[1]
    }

    #[cfg(not(feature = "judge-pool"))]
    fn root(&self) -> Hash {
        let mut nodes = [ZERO; LEAVES];
        nodes[..self.leaves.len()].copy_from_slice(&self.leaves);
        let mut width = LEAVES;
        while width > 1 {
            for i in 0..width / 2 {
                #[cfg(not(feature = "browser-pool"))]
                {
                    nodes[i] = digest(&[b"QM:branch:1", &nodes[2 * i], &nodes[2 * i + 1]]);
                }
                #[cfg(feature = "browser-pool")]
                {
                    nodes[i] = crate::pool_poseidon::branch(&nodes[2 * i], &nodes[2 * i + 1]);
                }
            }
            width /= 2;
        }
        nodes[0]
    }

    fn check_spend(
        &mut self,
        root: Hash,
        n: [Hash; 2],
        position: Hash,
        change: Hash,
        context: Hash,
        tag: Hash,
        entry: u16,
        withdrawal: u64,
        proof: &[u8],
    ) {
        require!(root == self.root(), "ERR_POOL_ROOT_CHANGED");
        require!(
            n[0] != ZERO && n[0] != n[1] && n.iter().all(|v| !self.spent.contains(v)),
            "ERR_NOTE_SPENT"
        );
        require!(change == ZERO || self.can_append(&change, 0), "ERR_CHANGE");
        let inputs = proof_inputs(
            &[
                self.domain,
                root,
                n[0],
                n[1],
                position,
                change,
                context,
                tag,
            ],
            &[u64::from(n[1] != ZERO), u64::from(entry), withdrawal],
        );
        require!(verify(&self.spend_vk, proof, &inputs), "ERR_PROOF_INVALID");
        self.spent
            .extend(n.into_iter().filter(|value| *value != ZERO));
    }
}
