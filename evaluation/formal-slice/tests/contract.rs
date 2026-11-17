use formal_slice::window;

#[test]
fn covers_an_in_bounds_prefix_and_an_out_of_bounds_range() {
    let input = [10, 20, 30, 40];
    assert_eq!(window(&input, 0, 3), Some(&input[..3]));
    assert_eq!(window(&input, 0, 5), None);
}
