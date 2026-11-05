use idevice::core_device::{ReportBlock, SenderReport};
use std::time::Instant;

/// Extended sequence and sender-report timing are required for the phone to
/// distinguish a live receiver from a stalled one, including silent audio.
#[derive(Default)]
pub struct Reports {
    first: Option<u32>,
    highest: Option<u32>,
    sender_report: Option<(u32, Instant)>,
    sender_packets: Option<u32>,
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
        self.first.get_or_insert(next);
    }
    pub fn control(&mut self, bytes: &[u8], source: u32) -> bool {
        if let Some(report) = SenderReport::parse_first(bytes).filter(|r| r.ssrc == source) {
            self.sender_report = Some((report.ntp_middle, Instant::now()));
            self.sender_packets = sender_packet_count(bytes, source);
            return true;
        }
        false
    }
    /// The sender has produced no packets beyond our last complete picture.
    /// A heartbeat alone, an incomplete frame, or an unreceived tail is not proof.
    pub fn confirms_idle(&self, completed_sequence: Option<u16>) -> bool {
        match (
            self.first,
            self.highest,
            self.sender_packets,
            completed_sequence,
        ) {
            (Some(first), Some(highest), Some(sent), Some(completed)) => {
                highest as u16 == completed && sent == highest.wrapping_sub(first).wrapping_add(1)
            }
            _ => false,
        }
    }
    pub fn counts(&self) -> (u32, u32) {
        let span = self
            .highest
            .zip(self.first)
            .map_or(0, |(last, first)| last.wrapping_sub(first).wrapping_add(1));
        (self.sender_packets.unwrap_or(0), span)
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
fn sender_packet_count(bytes: &[u8], source: u32) -> Option<u32> {
    let mut offset = 0;
    while offset + 4 <= bytes.len() {
        let size =
            (usize::from(u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]])) + 1) * 4;
        if offset + size > bytes.len() || bytes[offset] >> 6 != 2 {
            return None;
        }
        if bytes[offset + 1] == 200 && size >= 28 {
            let word =
                |i| u32::from_be_bytes(bytes[offset + i..offset + i + 4].try_into().unwrap());
            if word(4) == source {
                return Some(word(20));
            }
        }
        offset += size;
    }
    None
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
    #[test]
    fn idle_requires_complete_picture_and_all_sender_packets() {
        let mut report = vec![0x80, 200, 0, 6];
        for word in [7u32, 1, 0, 9000, 3, 1024] {
            report.extend(word.to_be_bytes());
        }
        let mut r = Reports::default();
        for seq in [65534, 65535, 0] {
            r.packet(seq);
        }
        assert!(r.control(&report, 7));
        assert!(r.confirms_idle(Some(0))); // extended sequence wraps, count does not
        assert!(!r.confirms_idle(Some(65535))); // newest packet has not completed a picture
        assert!(!r.confirms_idle(None)); // no picture yet
        report[20..24].copy_from_slice(&4u32.to_be_bytes());
        r.control(&report, 7);
        assert!(!r.confirms_idle(Some(0))); // a whole unreceived frame is still stale
        r.packet(1);
        assert!(r.confirms_idle(Some(1)));
        assert!(!r.control(&report, 8)); // wrong sender cannot confirm freshness
        assert_eq!(sender_packet_count(&report[..24], 7), None);
    }
}
