use cross_text::measure;

#[test]
fn contract() {
    assert_eq!(measure(&String::new()), 0);
    assert_eq!(measure(&String::from(" a  café ")), 6);
}
