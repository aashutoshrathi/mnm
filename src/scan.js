/**
 * scan.js — reading a join code off another phone's screen.
 *
 * Uses the platform's BarcodeDetector, which is Chromium-only. Rather than
 * shipping a decoder to paper over that, the join screen always offers manual
 * entry: the code is eight characters, and reading it aloud across a room takes
 * about as long as lining up a camera. Scanning is the fast path, not the only
 * path.
 *
 * The other fast path needs no code here at all — the invite QR encodes a URL,
 * so a guest can point their built-in camera app at it and land straight in the
 * game.
 */

/** True if this browser can detect QR codes natively. */
function scanSupported() {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

/**
 * Confirm the platform actually lists QR among its supported formats. Some
 * builds expose BarcodeDetector without it.
 */
export async function scanAvailable() {
  if (!scanSupported()) return false;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    return formats.includes('qr_code');
  } catch (e) {
    return false;
  }
}

/**
 * Open the rear camera and watch for a QR code.
 *
 * @param {HTMLVideoElement} video element to attach the stream to
 * @param {(value: string) => void} onResult called once, on first detection
 * @returns {Promise<{stop: () => void}>} handle that must be stopped by the caller
 * @throws {Error} with a human-readable message if the camera can't be opened
 */
export async function startScanner(video, onResult) {
  if (!(await scanAvailable())) {
    throw new Error('This browser cannot scan QR codes');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
  } catch (err) {
    throw new Error(cameraErrorMessage(err));
  }

  const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  let running = true;
  let frame = null;

  const stop = () => {
    running = false;
    if (frame) cancelAnimationFrame(frame);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };

  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play().catch(() => {});

  const tick = async () => {
    if (!running) return;
    try {
      const codes = await detector.detect(video);
      if (codes.length) {
        stop();
        onResult(codes[0].rawValue);
        return;
      }
    } catch (e) {
      /* a dropped frame is not worth aborting the scan */
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return { stop };
}

/** Camera failures are common and each one needs a different suggestion. */
function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return 'Camera permission was declined — type the code instead';
  if (name === 'NotFoundError') return 'No camera found on this device';
  if (name === 'NotReadableError') return 'The camera is busy in another app';
  if (name === 'SecurityError') return 'The camera needs a secure connection (https)';
  return 'Could not open the camera — type the code instead';
}
