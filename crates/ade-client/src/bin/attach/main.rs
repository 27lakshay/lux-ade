mod terminal_adapter;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    terminal_adapter::run()
}
