use method_refactors::{extract::invoice_total, inline::doubled_next, order::Order, pricing::Pricing};

#[test]
fn extracting_fee_preserves_rounding() {
    assert_eq!(invoice_total(9, 1), 9);
    assert_eq!(invoice_total(10, 1), 11);
    assert_eq!(invoice_total(13, 3), 42);
}

#[test]
fn inlined_argument_is_evaluated_once() {
    let mut calls = 0;
    let result = doubled_next(|| {
        calls += 1;
        calls
    });
    assert_eq!((result, calls), (2, 1));
}

#[test]
fn moved_discount_preserves_results_and_public_calls() {
    let pricing = Pricing::new(15);
    assert_eq!(pricing.rate(), 15);
    let order = Order::new(pricing);
    assert_eq!(order.total(0), 0);
    assert_eq!(order.total(13), 12);
    assert_eq!(order.total(100), 85);
}
