import { useEffect, useRef } from 'react';
// Only below-the-fold headings reveal; content and controls never wait for motion.
export function useScrollReveal() {
  const root = useRef(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const media = window.matchMedia('(prefers-reduced-motion: no-preference)');
    const pending = new Set([...element.querySelectorAll('.section-heading')]
      .filter(heading => heading.getBoundingClientRect().top >= window.innerHeight));
    const animations = new Set();
    const easing = getComputedStyle(element).getPropertyValue('--ease-out').trim();
    let observer;
    let stopped = false;
    const cancel = () => {
      observer?.disconnect();
      animations.forEach(animation => animation.cancel());
      animations.clear();
    };
    const observe = () => {
      cancel();
      if (stopped || !media.matches) return;
      observer = new IntersectionObserver(entries => {
        if (stopped || !media.matches) return;
        entries.forEach(({ target, isIntersecting }) => {
          if (!isIntersecting || !pending.delete(target)) return;
          observer.unobserve(target);
          const animation = target.animate([
            { opacity: 0.75, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ], { duration: 240, easing });
          animations.add(animation);
          animation.onfinish = () => animations.delete(animation);
        });
      }, { rootMargin: `0px 0px -${window.innerHeight * 0.05}px 0px` });
      pending.forEach(heading => observer.observe(heading));
    };
    const stop = () => {
      stopped = true;
      cancel();
    };
    observe();
    media.addEventListener('change', observe);
    window.addEventListener('resize', observe);
    document.addEventListener('keydown', stop, true);
    element.addEventListener('focusin', stop);
    return () => {
      stop();
      media.removeEventListener('change', observe);
      window.removeEventListener('resize', observe);
      document.removeEventListener('keydown', stop, true);
      element.removeEventListener('focusin', stop);
    };
  }, []);

  return root;
}
