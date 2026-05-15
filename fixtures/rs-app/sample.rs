// Sample Rust module for fixture tests.

pub const DEFAULT_TIMEOUT: u32 = 30;
const INTERNAL_BUFFER: usize = 1024;

pub type Id = u64;

pub struct Connection {
    pub host: String,
    port: u16,
}

struct InternalState {
    counter: u32,
}

pub enum Status {
    Ok,
    Err(String),
}

pub trait Querier {
    fn query(&self, sql: &str) -> String;
}

pub fn public_helper(x: i32) -> i32 {
    x * 2
}

fn private_helper(x: i32) -> i32 {
    x + 1
}

impl Connection {
    pub fn new(host: String) -> Self {
        Connection { host, port: 5432 }
    }

    fn close(&self) {
        // no-op
    }
}
