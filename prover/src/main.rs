use std::process::ExitCode;

fn main() -> ExitCode {
    // Report internal failures without payloads that could contain witness data.
    std::panic::set_hook(Box::new(|info| {
        let loc = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        eprintln!("error: internal prover failure{loc}");
    }));
    let args: Vec<String> = std::env::args().skip(1).collect();
    match xythum_prover::cli::main_with_stdin(&args) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(msg) => {
            eprintln!("error: {msg}");
            ExitCode::FAILURE
        }
    }
}
