mod bootstrap;
mod server;

fn main() -> anyhow::Result<()> {
    bootstrap::run()
}
