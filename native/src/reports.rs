use idevice::core_device::{ReportBlock, SenderReport};
use std::time::Instant;

/// Extended sequence and sender-report timing are required for the phone to
/// distinguish a live receiver from a stalled one, including silent audio.
#[derive(Default)]
pub struct Reports {
    highest: Option<u32>,
    sender_report: Option<(u32, Instant)>,
}
impl Reports {
    pub fn packet(&mut self, sequence: u16) {
        let next = match self.highest {
            None => u32::from(sequence),
            Some(previous) => {
                let delta = sequence.wrapping_sub(previous as u16) as i16;
                if delta <= 0 {
                    return;
                }
                previous.wrapping_add(delta as u32)
            }
        };
        self.highest = Some(next);
    }
    pub fn control(&mut self, bytes: &[u8], source: u32) {
        if let Some(report) = SenderReport::parse_first(bytes).filter(|r| r.ssrc == source) {
            self.sender_report = Some((report.ntp_middle, Instant::now()));
        }
    }
    pub fn block(&self, source: u32) -> ReportBlock {
        let (lsr, dlsr) = self.sender_report.map_or((0, 0), |(ntp, at)| {
            (
                ntp,
                (at.elapsed().as_secs_f64() * 65536.0).min(u32::MAX as f64) as u32,
            )
        });
        ReportBlock {
            source_ssrc: source,
            highest_seq: self.highest.unwrap_or(0),
            lsr,
            dlsr,
            ..Default::default()
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sequence_wrap_and_reordering() {
        let mut r = Reports::default();
        for seq in [65534, 65535, 0, 65535, 1] {
            r.packet(seq);
        }
        assert_eq!(r.block(7).highest_seq, 65537);
        assert_eq!(r.block(7).source_ssrc, 7);
    }
}
