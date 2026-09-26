import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Only below-the-fold headings reveal; content and controls never wait for motion.
export function useScrollReveal() {
  const root = useRef(null);

  useEffect(() => {
    if (!root.current) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', context => {
      context.add('reveal', element => {
        gsap.fromTo(element, { opacity: 0.75, y: 6 }, {
          opacity: 1, y: 0, duration: 0.24, ease: 'power3.out',
          clearProps: 'opacity,transform',
        });
      });
      root.current.querySelectorAll('.section-heading').forEach(element => {
        if (element.getBoundingClientRect().top < window.innerHeight) return;
        ScrollTrigger.create({
          trigger: element,
          start: 'top 95%',
          once: true,
          onEnter: () => context.reveal(element),
        });
      });
    }, root);

    const stop = () => media.revert();
    const element = root.current;
    document.addEventListener('keydown', stop, true);
    element.addEventListener('focusin', stop);
    return () => {
      document.removeEventListener('keydown', stop, true);
      element.removeEventListener('focusin', stop);
      media.revert();
    };
  }, []);

  return root;
}
