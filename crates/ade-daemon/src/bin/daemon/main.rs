mod bootstrap;
mod browser_reconcile;
mod server;

fn main() -> anyhow::Result<()> {
    bootstrap::run()
}
