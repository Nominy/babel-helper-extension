import { createHelperKernel } from '../core/kernel';

function boot() {
  const kernel = createHelperKernel();
  void kernel.start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
