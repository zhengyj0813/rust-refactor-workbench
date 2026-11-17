mod worker;

pub fn measure(value: &String) -> usize {
    worker::score(value.clone())
}
