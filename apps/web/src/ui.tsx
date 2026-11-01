import L from 'leaflet';
import { InputHTMLAttributes, ReactNode, useEffect, useRef, useState } from 'react';
import { Point } from './api';

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <span key={i} />)}
    </div>
  );
}

export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="notice row" role="alert">
      <span>{(error as Error).message}</span>
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  );
}

/**
 * The input owns its text so typing never lags. The value reaches the URL after a
 * short pause, and an outside change to the URL, such as "Clear search", flows back.
 */
export function UrlInput({ value, onCommit, ...props }: { value: string; onCommit: (value: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const lastCommitted = useRef(value);
  useEffect(() => {
    if (value !== lastCommitted.current) { lastCommitted.current = value; setText(value); }
  }, [value]);
  useEffect(() => {
    if (text === lastCommitted.current) return;
    const timer = setTimeout(() => { lastCommitted.current = text; onCommit(text); }, 200);
    return () => clearTimeout(timer);
  }, [text, onCommit]);
  return <input {...props} value={text} onChange={(e) => setText(e.target.value)} />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{children}</div>;
}

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export interface Marker extends Point { label: string; tone: '--color-accent' | '--color-cool' | '--color-ink' }

/** A real OpenStreetMap, redrawn only for its markers. Colours come from the theme tokens. */
export function LiveMap({ markers }: { markers: Marker[] }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, { center: [50.45, 30.52], zoom: 14 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(instance);
    map.current = instance;
    layer.current = L.layerGroup().addTo(instance);
    return () => { instance.remove(); fitted.current = false; };
  }, []);

  useEffect(() => {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    for (const marker of markers) {
      const color = token(marker.tone);
      L.circleMarker([marker.lat, marker.lng], { radius: 8, color: token('--color-paper-3'), weight: 2, fillColor: color, fillOpacity: 1 })
        .bindTooltip(marker.label)
        .addTo(layer.current);
    }
    if (markers.length && !fitted.current) {
      map.current.fitBounds(L.latLngBounds(markers.map((m) => [m.lat, m.lng])), { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    }
  }, [markers]);

  return <div ref={element} className="map" role="img" aria-label={markers.map((m) => m.label).join(', ') || 'Map'} />;
}
