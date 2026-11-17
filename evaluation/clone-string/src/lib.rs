fn count(value: String) -> usize {
    value.chars().count()
}

pub fn measure(value: &String) -> usize {
    count(value.clone())
}
