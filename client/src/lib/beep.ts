let ctx: AudioContext | null = null;

/** 신규 주문 알림음. 별도 오디오 파일 없이 Web Audio API로 짧은 비프음을 생성한다. */
export function playBeep() {
  try {
    ctx ??= new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.35);
  } catch {
    // 브라우저가 오디오 자동재생을 막았을 수 있음 — 무음 실패는 KDS 동작 자체를 막지 않는다.
  }
}
