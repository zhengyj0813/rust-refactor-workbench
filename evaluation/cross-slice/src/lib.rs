mod worker;

pub fn measure(values: &Vec<u8>) -> usize {
    worker::count(values.clone())
}
