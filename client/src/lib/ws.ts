import type { WsClientEvent, WsServerEvent } from '../types/protocol';
import { toWebSocketUrl } from './platform';

type EventHandler = (event: WsServerEvent) => void;
type StatusHandler = (status: 'connecting' | 'connected' | 'disconnected') => void;

export class SquadWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedManually = false;
  private serverUrl = '';
  private token = '';
  private attempt = 0;

  private onEvent: EventHandler;
  private onStatus: StatusHandler;

  constructor(onEvent: EventHandler, onStatus: StatusHandler) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  connect(serverUrl: string, token: string) {
    this.disconnect();
    this.closedManually = false;
    this.serverUrl = serverUrl;
    this.token = token;
    this.attempt = 0;
    this.openSocket();
  }

  private openSocket() {
    if (this.closedManually || !this.token) return;
    this.onStatus('connecting');

    const url = toWebSocketUrl(this.serverUrl, this.token);
    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.attempt = 0;
      this.onStatus('connected');
      this.startPing();
    };

    socket.onmessage = (msg) => {
      if (typeof msg.data !== 'string') return;
      try {
        const parsed = JSON.parse(msg.data) as WsServerEvent;
        this.onEvent(parsed);
      } catch {
        // Ignore malformed payloads
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.stopPing();
      this.onStatus('disconnected');
      if (!this.closedManually) {
        const delay = Math.min(8000, 1000 * Math.pow(1.5, this.attempt));
        this.attempt += 1;
        this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
      }
    };

    socket.onerror = () => {
      // onclose handles reconnect
    };
  }

  send(event: WsClientEvent): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(event));
    return true;
  }

  disconnect() {
    this.closedManually = true;
    this.stopPing();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onclose = null;
      old.close();
    }
    this.onStatus('disconnected');
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping', ts: Date.now() });
    }, 15000);
  }

  private stopPing() {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
