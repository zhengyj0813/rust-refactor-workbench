use crate::pricing::Pricing;

pub struct Order {
    pricing: Pricing,
}

impl Order {
    pub fn new(pricing: Pricing) -> Self {
        Self { pricing }
    }

    pub fn total(&self, subtotal: u32) -> u32 {
        subtotal - self.discount(subtotal)
    }

    fn discount(&self, subtotal: u32) -> u32 {
        subtotal * self.pricing.rate() / 100
    }
}
