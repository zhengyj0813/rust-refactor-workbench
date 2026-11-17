use cross_slice::measure;

#[test]
fn contract() {
    assert_eq!(measure(&vec![]), 0);
    assert_eq!(measure(&vec![0, 1, 2, 255]), 2);
}
