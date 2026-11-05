mod audio;
mod hevc;
mod reports;
use idevice::core_device::{
    CallInfoBlob, CoreDeviceServiceClient, RtpPacket, build_frame_ack, build_keyframe_request,
    build_liveness, build_rctl, build_screen_audio_offer, build_screen_video_offer,
    build_start_audio_parameters, build_start_video_parameters, is_rtcp,
};
use std::{
    ffi::c_void,
    net::{IpAddr, SocketAddr},
    os::fd::{FromRawFd, OwnedFd},
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    net::{TcpStream, UdpSocket, UnixStream},
};
type Error = Box<dyn std::error::Error>;
pub type Callback = extern "C" fn(*mut c_void, u32, u32, u32, *const u8, usize);
struct Events {
    callback: Callback,
    context: *mut c_void,
}
impl Events {
    fn send(&self, kind: u32, flags: u32, time: u32, bytes: &[u8]) {
        (self.callback)(self.context, kind, flags, time, bytes.as_ptr(), bytes.len());
    }
}
#[derive(Clone, Copy)]
struct Negotiation {
    peer: SocketAddr,
    sender: u32,
    receiver: u32,
    payload: u8,
}
fn dictionary<'a>(v: &'a plist::Value, key: &str) -> Result<&'a plist::Dictionary, Error> {
    v.as_dictionary()
        .and_then(|v| v.get(key))
        .and_then(plist::Value::as_dictionary)
        .ok_or_else(|| "Invalid stream negotiation".into())
}
fn number(d: &plist::Dictionary, key: &str) -> Result<u64, Error> {
    d.get(key)
        .and_then(plist::Value::as_unsigned_integer)
        .ok_or_else(|| "Invalid stream negotiation".into())
}
fn negotiation(answer: &plist::Value, remote: IpAddr, audio: bool) -> Result<Negotiation, Error> {
    let c = dictionary(answer, "connection")?;
    let s = c
        .get("streamConfig")
        .and_then(plist::Value::as_dictionary)
        .ok_or("Missing stream config")?;
    if number(s, "SRTPCipherSuite")? != 0 || number(s, "SRTCPCipherSuite")? != 0 {
        return Err("Unsupported media encryption".into());
    }
    if audio && number(s, "AudioStreamMode")? != 8 {
        return Err("Unsupported audio codec".into());
    }
    let payload = u8::try_from(number(s, "TxPayloadType")?)?;
    if payload != if audio { 101 } else { 100 } {
        return Err("Unsupported payload".into());
    }
    let port = u16::try_from(number(s, "SourcePort")?)?;
    if port == 0
        || s.get("SourceIP")
            .and_then(plist::Value::as_string)
            .and_then(|s| s.parse::<IpAddr>().ok())
            != Some(remote)
    {
        return Err("Unexpected stream endpoint".into());
    }
    let sender = u32::try_from(number(s, "LocalSSRC")?)?;
    let receiver = u32::try_from(number(s, "RemoteSSRC")?)?;
    if sender == 0 || receiver == 0 {
        return Err("Missing stream identity".into());
    }
    Ok(Negotiation {
        peer: SocketAddr::new(remote, port),
        sender,
        receiver,
        payload,
    })
}
fn tunnel_address(ip: IpAddr) -> bool {
    matches!(ip,IpAddr::V6(v) if v.segments()[0]&0xfe00==0xfc00)
}
async fn media(
    socket: std::net::TcpStream,
    events: &Events,
    cancel: std::os::unix::net::UnixStream,
) -> Result<(), Error> {
    let local = socket.local_addr()?.ip();
    let remote = socket.peer_addr()?.ip();
    if !tunnel_address(local) || !tunnel_address(remote) || local == remote {
        return Err("Expected paired tunnel socket".into());
    }
    socket.set_nonblocking(true)?;
    cancel.set_nonblocking(true)?;
    let mut cancel = UnixStream::from_std(cancel)?;
    let mut byte = [0u8; 1];
    let mut client = tokio::time::timeout(
        Duration::from_secs(5),
        CoreDeviceServiceClient::new(TcpStream::from_std(socket)?),
    )
    .await??;

    let result = tokio::select! {
     _=cancel.read(&mut byte)=>Ok(()),
     result=receive(&mut client,local,remote,events)=>result,
    };
    // Dropping both receivers abandons only this lease. We request a two-second
    // timeout; expiry is enforced by the phone. Never issue stopAll.
    result
}
async fn receive(
    client: &mut CoreDeviceServiceClient<TcpStream>,
    local: IpAddr,
    remote: IpAddr,
    events: &Events,
) -> Result<(), Error> {
    let audio = UdpSocket::bind((local, 0)).await?;
    let video = UdpSocket::bind((local, 0)).await?;
    let info = CallInfoBlob {
        call_id: 0,
        client_version: 1,
        device_type: "Mac".into(),
        framework_version: "2205.3.1".into(),
        os_version: "26A".into(),
        device_name: None,
        audio_device_uid: None,
    };
    let id = uuid::Uuid::new_v4();
    let ssrc = uuid::Uuid::new_v4().as_u128() as u32;
    let offer = build_screen_video_offer(&uuid::Uuid::new_v4().to_string(), &info, ssrc)?;
    let mut p = build_start_video_parameters(
        &local.to_string(),
        video.local_addr()?.port(),
        &remote.to_string(),
        50001,
        offer,
        140,
        1,
        id,
    );
    p.insert("timeout".into(), idevice::xpc::XPCObject::UInt64(2));
    let answer = tokio::time::timeout(
        Duration::from_secs(5),
        client.invoke("com.apple.coredevice.feature.startmediastream", Some(p)),
    )
    .await??;
    let vn = match negotiation(&answer, remote, false) {
        Ok(value) => value,
        Err(error) => {
            events.send(
                7,
                0,
                0,
                br#"{"control":"eligible","video":"unavailable","audio":"unavailable"}"#,
            );
            return Err(error);
        }
    };
    video.connect(vn.peer).await?;
    // Video is independently useful. Audio rejection, unsupported codec, or a
    // negotiation timeout must not discard an already negotiated picture.
    let audio_negotiation = async {
        let offer = build_screen_audio_offer(&uuid::Uuid::new_v4().to_string(), &info)?;
        let mut p = build_start_audio_parameters(
            &local.to_string(),
            audio.local_addr()?.port(),
            &remote.to_string(),
            50000,
            offer,
            140,
            id,
        );
        p.insert("timeout".into(), idevice::xpc::XPCObject::UInt64(2));
        let answer = tokio::time::timeout(
            Duration::from_secs(5),
            client.invoke("com.apple.coredevice.feature.startmediastream", Some(p)),
        )
        .await??;
        let an = negotiation(&answer, remote, true)?;
        audio.connect(an.peer).await?;
        Ok::<Negotiation, Error>(an)
    };
    tokio::pin!(audio_negotiation);
    let mut audio_pending = true;
    let mut an: Option<Negotiation> = None;
    events.send(
        7,
        0,
        0,
        br#"{"control":"eligible","video":"supported","audio":"eligible"}"#,
    );
    let mut audio_queue = audio::AudioQueue::default();
    let mut video_reports = reports::Reports::default();
    let mut audio_reports = reports::Reports::default();
    let start = Instant::now();
    let mut last_packet = start;
    let mut completed_sequence = None;
    let mut completed_timestamp = 0;
    let mut last_keyframe = start - Duration::from_secs(1);
    let mut keyframe_sequence = 0;
    let mut seq = 0;
    let mut received = 0u64;
    let mut completed = 0u64;
    let mut lost = 0u64;
    let mut ext = String::new();
    let mut last_stats = Instant::now();
    let mut frames: u16 = 0;
    let mut assembler = hevc::Assembler::new();
    let mut vb = vec![0u8; 65536];
    let mut ab = vec![0u8; 65536];
    let mut report = tokio::time::interval(Duration::from_millis(50));
    report.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut alive = tokio::time::interval(Duration::from_millis(250));
    alive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
         result=&mut audio_negotiation, if audio_pending=>{
          audio_pending = false; an = result.ok();
          events.send(7, 0, 0, if an.is_some() {
           br#"{"control":"eligible","video":"supported","audio":"supported"}"#
          } else {
           br#"{"control":"eligible","video":"supported","audio":"unavailable"}"#
          });
         },
         d=video.recv(&mut vb)=>{let len=d?;last_packet=Instant::now();if is_rtcp(&vb[..len]){
           if video_reports.control(&vb[..len],vn.sender) && video_reports.confirms_idle(completed_sequence) { events.send(8,0,completed_timestamp,&[]); }
           continue
          };
          let p=RtpPacket::parse(&vb[..len]).ok_or("Invalid video RTP")?;
          if p.payload_type!=vn.payload||p.ssrc!=vn.sender{return Err("Unexpected video sender".into())}
          received+=1; if p.extension { ext=format!("{:04x}:{:02x?}",p.ext_profile,p.ext_data); } seq=p.sequence_number;video_reports.packet(seq);
          match assembler.push(p.sequence_number,p.timestamp,p.marker,p.payload){
           Ok(Some(frame))=>{completed_sequence=Some(p.sequence_number);completed_timestamp=p.timestamp;completed+=1;if !frame.configuration.is_empty(){events.send(2,0,p.timestamp,&frame.configuration)}events.send(1,u32::from(frame.sync),p.timestamp,&frame.bytes);frames=frames.wrapping_add(1);video.send(&build_frame_ack(vn.receiver,p.timestamp)).await?;},
           Ok(None)=>{},
           Err(())=>{lost+=1;events.send(5,0,0,&[]);if last_keyframe.elapsed()>=Duration::from_millis(250){video.send(&build_keyframe_request(vn.receiver,"iportal",vn.sender,&[],keyframe_sequence)).await?;keyframe_sequence=keyframe_sequence.wrapping_add(1);last_keyframe=Instant::now();}}
          }
         },
         d=audio.recv(&mut ab), if an.is_some()=>{
          if let (Ok(len), Some(an)) = (d, an) {
           if is_rtcp(&ab[..len]) { audio_reports.control(&ab[..len],an.sender); continue; }
           if let Some(p) = RtpPacket::parse(&ab[..len]) && p.payload_type == an.payload && p.ssrc == an.sender {
             audio_reports.packet(p.sequence_number);
             audio_queue.push(p.sequence_number,p.timestamp,p.payload,Instant::now());
             for packet in audio_queue.drain(Instant::now()) { events.send(3,0,packet.timestamp,&packet.bytes); }
           }
          }
         },
         _=async { if let Some(at) = audio_queue.deadline() { tokio::time::sleep_until(at.into()).await; } else { std::future::pending::<()>().await; } }=>{
          for packet in audio_queue.drain(Instant::now()) { events.send(3,0,packet.timestamp,&packet.bytes); }
         },
         _=report.tick()=>{video.send(&build_rctl(vn.receiver,start.elapsed().as_millis() as u16,frames,seq)).await?;},
         _=alive.tick()=>{
          if last_stats.elapsed()>=Duration::from_secs(2) {
           let (sender_packets,sequence_span) = video_reports.counts();
           let idle = video_reports.confirms_idle(completed_sequence);
           events.send(6,0,0,format!("{{\"packets\":{received},\"frames\":{completed},\"losses\":{lost},\"senderPackets\":{sender_packets},\"sequenceSpan\":{sequence_span},\"idleConfirmed\":{idle},\"extension\":\"{ext}\"}}").as_bytes());
           last_stats=Instant::now();
          }
          if last_packet.elapsed()>Duration::from_secs(5){return Err("Stream stopped responding".into())}
          video.send(&build_liveness(vn.receiver,"iportal",&[video_reports.block(vn.sender)])).await?;
          if let Some(an) = an { let _ = audio.send(&build_liveness(an.receiver,"iportal",&[audio_reports.block(an.sender)])).await; }
         },
        }
    }
}
/// # Safety
/// Caller transfers valid, distinct, owned socket descriptors. `context` remains
/// valid until return. Callback must not unwind and must copy borrowed bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn iportal_media_run(
    fd: i32,
    cancel_fd: i32,
    callback: Callback,
    context: *mut c_void,
) -> i32 {
    if fd < 0 || cancel_fd < 0 || fd == cancel_fd {
        return -1;
    }
    // Ownership is acquired before any fallible setup; all exit paths close sockets.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let cancel = unsafe { OwnedFd::from_raw_fd(cancel_fd) };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(media(
            std::net::TcpStream::from(fd),
            &Events { callback, context },
            std::os::unix::net::UnixStream::from(cancel),
        ))
    }));
    match result {
        Ok(Ok(())) => 0,
        _ => -1,
    }
}
