pub struct Pricing {
    rate: u32,
}

impl Pricing {
    pub fn new(rate: u32) -> Self {
        Self { rate }
    }

    pub fn rate(&self) -> u32 {
        self.rate
    }
}
