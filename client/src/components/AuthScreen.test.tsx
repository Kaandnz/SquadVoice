// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthScreen } from './AuthScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function inviteInput(): HTMLInputElement | null {
  const label = Array.from(container.querySelectorAll('label')).find((l) =>
    l.textContent?.includes('Davet Kodu'),
  );
  return label?.querySelector('input') ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState(null, '', '/');
});

describe('AuthScreen invite links', () => {
  it('opens sign-up with the code from the link and removes it from the address', () => {
    window.history.replaceState(null, '', '/?davet=SQUAD-7KQ2M9XA');
    act(() => root.render(<AuthScreen />));

    expect(inviteInput()?.value).toBe('SQUAD-7KQ2M9XA');
    expect(container.textContent).toContain('Davet linkiyle geldin');
    expect(window.location.search).toBe('');
  });

  it('starts on login with an empty code when opened normally', () => {
    act(() => root.render(<AuthScreen />));

    expect(inviteInput()).toBeNull();
    const signUpTab = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Kayıt Ol',
    );
    act(() => signUpTab?.click());
    expect(inviteInput()?.value).toBe('');
  });
});
