mod bootstrap;
mod server;
mod service_proxy;
mod terminal_host;

fn main() -> anyhow::Result<()> {
    bootstrap::run()
}
