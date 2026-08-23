/**
 * p2p.js - serverless real-time room synchronization for multi-device play.
 *
 * Combines local BroadcastChannel (for same-device tabs/windows) and a public
 * WebSocket MQTT broker (for cross-device phones across the internet) to provide
 * zero-config real-time synchronization between Host and Guest devices:
 *
 *   1. Automatic 1-tap round start (Host taps start -> Guest clock starts).
 *   2. Real-time drawing strokes streamed to the Opponent Sideboard.
 *   3. Synchronized score, round transitions, team renames, and wrap-up.
 *
 * If network connectivity is unavailable, it degrades gracefully to standard
 * deterministic offline play with zero errors.
 */

const MQTT_BROKER = 'wss://broker.emqx.io:8084/mqtt';

let p2pWs = null;
let p2pChannel = null;
let p2pRoomTopic = '';
let p2pRole = 'host';
let p2pConnected = false;
let p2pMessageHandler = () => {};
let p2pStatusHandler = () => {};

function encodeConnect(id) {
  const protocol = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c];
  const idBytes = new TextEncoder().encode(id);
  const payload = new Uint8Array(2 + idBytes.length);
  payload[0] = (idBytes.length >> 8) & 0xff;
  payload[1] = idBytes.length & 0xff;
  payload.set(idBytes, 2);

  const varHeader = new Uint8Array(protocol);
  const remaining = new Uint8Array(varHeader.length + payload.length);
  remaining.set(varHeader, 0);
  remaining.set(payload, varHeader.length);

  const packet = new Uint8Array(2 + remaining.length);
  packet[0] = 0x10;
  packet[1] = remaining.length;
  packet.set(remaining, 2);
  return packet;
}

function encodeSubscribe(topic) {
  const packetId = new Uint8Array([0x00, 0x01]);
  const tBytes = new TextEncoder().encode(topic);
  const payload = new Uint8Array(2 + tBytes.length + 1);
  payload[0] = (tBytes.length >> 8) & 0xff;
  payload[1] = tBytes.length & 0xff;
  payload.set(tBytes, 2);
  payload[payload.length - 1] = 0x00;

  const remaining = new Uint8Array(packetId.length + payload.length);
  remaining.set(packetId, 0);
  remaining.set(payload, packetId.length);

  const packet = new Uint8Array(2 + remaining.length);
  packet[0] = 0x82;
  packet[1] = remaining.length;
  packet.set(remaining, 2);
  return packet;
}

function encodePublish(topic, message) {
  const tBytes = new TextEncoder().encode(topic);
  const mBytes = new TextEncoder().encode(message);
  const varHeader = new Uint8Array(2 + tBytes.length);
  varHeader[0] = (tBytes.length >> 8) & 0xff;
  varHeader[1] = tBytes.length & 0xff;
  varHeader.set(tBytes, 2);

  const remaining = new Uint8Array(varHeader.length + mBytes.length);
  remaining.set(varHeader, 0);
  remaining.set(mBytes, varHeader.length);

  const packet = new Uint8Array(2 + remaining.length);
  packet[0] = 0x30;
  packet[1] = remaining.length;
  packet.set(remaining, 2);
  return packet;
}

export function isP2PConnected() {
  return p2pConnected;
}

export function sendP2P(type, payload = {}) {
  const data = {
    type,
    ...payload,
    from: p2pRole,
    ts: Date.now(),
  };
  const json = JSON.stringify(data);

  if (p2pChannel) {
    try {
      p2pChannel.postMessage(data);
    } catch (err) {
      /* channel error ignored */
    }
  }

  if (p2pWs && p2pWs.readyState === 1 && p2pRoomTopic) {
    try {
      p2pWs.send(encodePublish(p2pRoomTopic, json));
    } catch (err) {
      /* network error ignored */
    }
  }
}

export function connectP2P({
  code = '',
  role = 'host',
  onMessage = () => {},
  onStatusChange = () => {},
} = {}) {
  disconnectP2P();

  p2pRole = role;
  p2pMessageHandler = onMessage;
  p2pStatusHandler = onStatusChange;

  const cleanCode = (code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!cleanCode) return;

  p2pRoomTopic = `mnm/room/${cleanCode}`;

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      p2pChannel = new BroadcastChannel(`mnm-room-${cleanCode}`);
      p2pChannel.onmessage = (e) => {
        const msg = e.data;
        if (!msg || msg.from === p2pRole) return;
        p2pMessageHandler(msg);
      };
    } catch (err) {
      p2pChannel = null;
    }
  }

  if (typeof WebSocket !== 'undefined') {
    try {
      const clientId = `mnm-${role}-${Math.random().toString(36).slice(2, 8)}`;
      p2pWs = new WebSocket(MQTT_BROKER, ['mqtt']);
      p2pWs.binaryType = 'arraybuffer';

      p2pWs.onopen = () => {
        p2pWs.send(encodeConnect(clientId));
      };

      p2pWs.onmessage = (e) => {
        const buf = new Uint8Array(e.data);
        const type = buf[0] >> 4;

        if (type === 2) {
          /* CONNACK received */
          p2pConnected = true;
          p2pStatusHandler({ connected: true });
          p2pWs.send(encodeSubscribe(p2pRoomTopic));
          sendP2P('PEER_PING', { role: p2pRole });
        } else if (type === 3) {
          /* PUBLISH received */
          let offset = 2;
          const topicLen = (buf[offset] << 8) | buf[offset + 1];
          offset += 2 + topicLen;
          const payloadStr = new TextDecoder().decode(buf.subarray(offset));
          try {
            const parsed = JSON.parse(payloadStr);
            if (!parsed || parsed.from === p2pRole) return;
            p2pMessageHandler(parsed);
          } catch (err) {
            /* ignore malformed payload */
          }
        }
      };

      p2pWs.onerror = () => {
        p2pConnected = false;
        p2pStatusHandler({ connected: false });
      };

      p2pWs.onclose = () => {
        p2pConnected = false;
        p2pStatusHandler({ connected: false });
      };
    } catch (err) {
      p2pWs = null;
    }
  }
}

export function disconnectP2P() {
  p2pConnected = false;
  p2pRoomTopic = '';
  if (p2pChannel) {
    try {
      p2pChannel.close();
    } catch (err) {}
    p2pChannel = null;
  }
  if (p2pWs) {
    try {
      p2pWs.close();
    } catch (err) {}
    p2pWs = null;
  }
}
