pub fn invoice_total(price: u32, quantity: u32) -> u32 {
    let subtotal = price * quantity;
    let fee = subtotal / 10;
    subtotal + fee
}
