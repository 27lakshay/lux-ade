mod bootstrap;
mod server;
mod terminal_host;

fn main() -> anyhow::Result<()> {
    bootstrap::run()
}
