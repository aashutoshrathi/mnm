/**
 * p2p.js - serverless real-time room synchronization for multi-device play.
 *
 * Combines local BroadcastChannel (for same-device tabs/windows) and public
 * WebSocket MQTT brokers (for cross-device phones across the internet) to provide
 * zero-config real-time synchronization between Host and Guest devices:
 *
 *   1. Synchronized Room Lobby and presence heartbeats.
 *   2. State catch-up (SYNC_REQUEST / ROOM_STATE) when joining at any time.
 *   3. Synchronized Ready Lobbies, Word Selection, and Countdown beeps.
 *   4. Real-time drawing strokes streamed to the Opponent Sideboard.
 *   5. Synchronized score, round transitions, team renames, and wrap-up.
 *
 * Messages are validated before delivery to the handler: numeric fields are
 * range-checked (winner, scores, round, pts, champIndex, teamIndex) and
 * out-of-range values are silently dropped.
 */

const BROKER_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const HEARTBEAT_INTERVAL_MS = 5000;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;

let p2pWs = null;
let p2pChannel = null;
let p2pRoomTopic = '';
let p2pRole = 'host';
let p2pConnected = false;
let p2pSubscribed = false;
let p2pBrokerIndex = 0;
let p2pReconnectTimer = null;
let p2pReconnectDelay = RECONNECT_BASE_MS;
let p2pHeartbeatTimer = null;
let p2pMessageHandler = () => {};
let p2pStatusHandler = () => {};

const p2pSendQueue = [];

/* ----------------------------------------------------------- validation */

/**
 * Sanitize an incoming P2P message before it reaches the game logic.
 * Drops messages with out-of-range numeric fields or malformed structure.
 * Returns null if the message should be discarded.
 */
function sanitizeMessage(msg) {
  if (!msg || typeof msg !== 'object' || !msg.type) return null;

  const m = { ...msg };

  if (m.winner !== undefined && m.winner !== null) {
    if (m.winner !== 0 && m.winner !== 1) return null;
  }
  if (m.team0Score !== undefined) {
    if (!Number.isInteger(m.team0Score) || m.team0Score < 0) return null;
  }
  if (m.team1Score !== undefined) {
    if (!Number.isInteger(m.team1Score) || m.team1Score < 0) return null;
  }
  if (m.round !== undefined) {
    if (!Number.isInteger(m.round) || m.round < 1) return null;
  }
  if (m.pts !== undefined) {
    if (!Number.isInteger(m.pts) || m.pts < 1 || m.pts > 3) return null;
  }
  if (m.champIndex !== undefined) {
    if (m.champIndex !== 0 && m.champIndex !== 1) return null;
  }
  if (m.teamIndex !== undefined) {
    if (m.teamIndex !== 0 && m.teamIndex !== 1) return null;
  }
  if (m.history !== undefined) {
    if (!Array.isArray(m.history)) return null;
    for (const h of m.history) {
      if (!h || typeof h !== 'object') return null;
      if (h.win !== null && h.win !== undefined && h.win !== 0 && h.win !== 1) return null;
      if (h.p !== undefined && (!Number.isInteger(h.p) || h.p < 1 || h.p > 3)) return null;
      if (h.w !== undefined && typeof h.w !== 'string') return null;
      if (h.t !== undefined && typeof h.t !== 'string') return null;
    }
  }

  return m;
}

function encodeVarInt(num) {
  const bytes = [];
  do {
    let digit = num % 128;
    num = Math.floor(num / 128);
    if (num > 0) digit = digit | 0x80;
    bytes.push(digit);
  } while (num > 0);
  return new Uint8Array(bytes);
}

function decodeVarInt(buf, offset = 1) {
  let multiplier = 1;
  let value = 0;
  let byteCount = 0;
  let digit = 0;
  do {
    if (offset + byteCount >= buf.length) {
      return { value: 0, length: 0, valid: false };
    }
    digit = buf[offset + byteCount];
    value += (digit & 127) * multiplier;
    multiplier *= 128;
    byteCount++;
  } while ((digit & 128) !== 0 && byteCount < 4);

  if ((digit & 128) !== 0) {
    return { value: 0, length: 0, valid: false };
  }
  return { value, length: byteCount, valid: true };
}

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

  const lenBytes = encodeVarInt(remaining.length);
  const packet = new Uint8Array(1 + lenBytes.length + remaining.length);
  packet[0] = 0x10;
  packet.set(lenBytes, 1);
  packet.set(remaining, 1 + lenBytes.length);
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

  const lenBytes = encodeVarInt(remaining.length);
  const packet = new Uint8Array(1 + lenBytes.length + remaining.length);
  packet[0] = 0x82;
  packet.set(lenBytes, 1);
  packet.set(remaining, 1 + lenBytes.length);
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

  const lenBytes = encodeVarInt(remaining.length);
  const packet = new Uint8Array(1 + lenBytes.length + remaining.length);
  packet[0] = 0x30;
  packet.set(lenBytes, 1);
  packet.set(remaining, 1 + lenBytes.length);
  return packet;
}

export function isP2PConnected() {
  return p2pConnected && p2pSubscribed;
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

  if (p2pWs && p2pWs.readyState === 1 && p2pSubscribed && p2pRoomTopic) {
    try {
      p2pWs.send(encodePublish(p2pRoomTopic, json));
    } catch (err) {
      /* network error ignored */
    }
  } else if (p2pRoomTopic) {
    if (p2pSendQueue.length < 500) {
      p2pSendQueue.push(json);
    }
  }
}

function flushSendQueue() {
  if (!p2pWs || p2pWs.readyState !== 1 || !p2pSubscribed || !p2pRoomTopic) return;
  while (p2pSendQueue.length > 0) {
    const json = p2pSendQueue.shift();
    try {
      p2pWs.send(encodePublish(p2pRoomTopic, json));
    } catch (err) {
      break;
    }
  }
}

function deliverMessage(parsed) {
  const clean = sanitizeMessage(parsed);
  if (clean) p2pMessageHandler(clean);
}

function setupWebSocket(clientId) {
  if (typeof WebSocket === 'undefined' || !p2pRoomTopic) return;
  try {
    const brokerUrl = BROKER_URLS[p2pBrokerIndex % BROKER_URLS.length];
    p2pWs = new WebSocket(brokerUrl, ['mqtt']);
    p2pWs.binaryType = 'arraybuffer';

    p2pWs.onopen = () => {
      p2pWs.send(encodeConnect(clientId));
    };

    p2pWs.onmessage = (e) => {
      const buf = new Uint8Array(e.data);
      let pos = 0;
      while (pos < buf.length) {
        if (pos + 1 >= buf.length) break;
        const header = buf[pos];
        const type = header >> 4;
        const dec = decodeVarInt(buf, pos + 1);
        if (!dec.valid || dec.length === 0) break;
        const remainingLength = dec.value;
        const packetStart = pos;
        const packetEnd = pos + 1 + dec.length + remainingLength;

        if (packetEnd > buf.length) break;

        if (type === 2) {
          /* CONNACK received */
          p2pConnected = true;
          p2pWs.send(encodeSubscribe(p2pRoomTopic));
        } else if (type === 9) {
          /* SUBACK received */
          p2pSubscribed = true;
          p2pReconnectDelay = RECONNECT_BASE_MS;
          p2pStatusHandler({ connected: true });
          flushSendQueue();
          sendP2P('PEER_PING', { role: p2pRole });
        } else if (type === 3) {
          /* PUBLISH received */
          const qos = (header & 0x06) >> 1;
          let offset = packetStart + 1 + dec.length;
          const topicLen = (buf[offset] << 8) | buf[offset + 1];
          offset += 2 + topicLen;
          if (qos > 0) offset += 2;
          const payloadBytes = buf.subarray(offset, packetEnd);
          const payloadStr = new TextDecoder().decode(payloadBytes);
          try {
            const parsed = JSON.parse(payloadStr);
            if (parsed && parsed.from !== p2pRole) {
              deliverMessage(parsed);
            }
          } catch (err) {
            /* ignore malformed payload */
          }
        }

        pos = packetEnd;
      }
    };

    p2pWs.onerror = () => {
      p2pConnected = false;
      p2pSubscribed = false;
      p2pStatusHandler({ connected: false });
    };

    p2pWs.onclose = () => {
      p2pConnected = false;
      p2pSubscribed = false;
      p2pStatusHandler({ connected: false });
      if (p2pRoomTopic) {
        clearTimeout(p2pReconnectTimer);
        p2pBrokerIndex++;
        p2pReconnectTimer = setTimeout(() => setupWebSocket(clientId), p2pReconnectDelay);
        p2pReconnectDelay = Math.min(p2pReconnectDelay * 2, RECONNECT_MAX_MS);
      }
    };
  } catch (err) {
    p2pWs = null;
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
        deliverMessage(msg);
      };
    } catch (err) {
      p2pChannel = null;
    }
  }

  const clientId = `mnm-${role}-${Math.random().toString(36).slice(2, 8)}`;
  p2pReconnectDelay = RECONNECT_BASE_MS;
  setupWebSocket(clientId);

  clearInterval(p2pHeartbeatTimer);
  p2pHeartbeatTimer = setInterval(() => {
    if (p2pRoomTopic) {
      if (p2pWs && p2pWs.readyState === 1) {
        try {
          p2pWs.send(new Uint8Array([0xc0, 0x00])); // MQTT PINGREQ
        } catch (err) {}
      }
      sendP2P('PEER_PING', { role: p2pRole });
    }
  }, HEARTBEAT_INTERVAL_MS);
}

export function disconnectP2P() {
  p2pConnected = false;
  p2pSubscribed = false;
  p2pRoomTopic = '';
  p2pSendQueue.length = 0;
  clearTimeout(p2pReconnectTimer);
  clearInterval(p2pHeartbeatTimer);
  p2pReconnectTimer = null;
  p2pHeartbeatTimer = null;
  p2pReconnectDelay = RECONNECT_BASE_MS;
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
