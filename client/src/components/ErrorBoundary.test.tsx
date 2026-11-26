// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let shouldThrow = true;
function Flaky() {
  if (shouldThrow) throw new Error('mesaj ayrıştırılamadı');
  return <p>sohbet içeriği</p>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  shouldThrow = true;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('contains a panel crash and keeps siblings rendered', () => {
    act(() => {
      root.render(
        <>
          <ErrorBoundary area="Sohbet">
            <Flaky />
          </ErrorBoundary>
          <p>ses odası</p>
        </>,
      );
    });

    expect(container.textContent).toContain('Sohbet yüklenirken bir sorun oluştu.');
    expect(container.textContent).toContain('mesaj ayrıştırılamadı');
    expect(container.textContent).toContain('ses odası');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('renders the child again after "Tekrar dene" once the fault is gone', () => {
    act(() => {
      root.render(
        <ErrorBoundary area="Sohbet">
          <Flaky />
        </ErrorBoundary>,
      );
    });
    shouldThrow = false;
    const retry = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Tekrar dene'),
    );
    act(() => retry?.click());

    expect(container.textContent).toContain('sohbet içeriği');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('offers only a reload when a lazily loaded part failed to download', () => {
    function MissingChunk(): never {
      throw new TypeError(
        'Failed to fetch dynamically imported module: https://x.web.app/assets/SettingsModal-abc.js',
      );
    }
    act(() => {
      root.render(
        <ErrorBoundary area="Ayarlar">
          <MissingChunk />
        </ErrorBoundary>,
      );
    });
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(container.textContent).toContain('yeni sürümü yayınlandı');
    expect(labels.some((l) => l?.includes('Sayfayı yenile'))).toBe(true);
    expect(labels.some((l) => l?.includes('Tekrar dene'))).toBe(false);
  });

  it('uses the app-wide wording without an area', () => {
    act(() => {
      root.render(
        <ErrorBoundary>
          <Flaky />
        </ErrorBoundary>,
      );
    });
    expect(container.textContent).toContain('Bir şeyler ters gitti.');
  });
});
