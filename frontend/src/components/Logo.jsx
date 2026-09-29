import { useId } from 'react';
import { useT } from '../utils/i18n';

export default function Logo({ style, className }) {
  const { t } = useT();
  const id = useId();
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={t('common.logoAlt')}
      className={['brand-logo', className].filter(Boolean).join(' ')}
      style={{ width: '100%', height: '100%', ...style }}
    >
      <defs>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="10%" stopColor="#d8efff"/>
          <stop offset="42%" stopColor="#89c6f2"/>
          <stop offset="52%" stopColor="#3478b8"/>
          <stop offset="90%" stopColor="#79b9ed"/>
        </linearGradient>
        <linearGradient id={`${id}-cover`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#79b9ed"/>
          <stop offset="48%" stopColor="#3478b8"/>
          <stop offset="100%" stopColor="#214f78"/>
        </linearGradient>
        <path id={`${id}-m`} d="M12.5 16.62Q13.639 16.011 14.738 16.011Q15.837 16.011 16.751 16.476Q18.58 17.422 19.88 19.572L22.751 24.241L27.516 17.134H27.66L29.473 26.519Q30.019 29.406 31.094 30.529Q31.944 31.412 33.259 31.412H33.5V31.572Q32.505 31.989 31.43 31.989Q29.297 31.989 27.725 30.321Q26.409 28.941 25.88 26.422L25.142 23.037L22.398 27.112Q22.126 27.497 21.917 28.043Q21.709 28.588 21.725 28.973H21.58L17.682 22.299L16.88 27.69V27.754Q16.88 28.011 17.064 28.227Q17.249 28.444 17.505 28.444H17.746V28.588H14.233V28.428H14.489Q14.922 28.428 15.251 28.163Q15.58 27.898 15.66 27.449L16.767 20.567Q15.949 19.139 14.955 18.032Q13.816 16.781 12.676 16.781H12.548Z"/>
      </defs>
      <rect x="5" y="3" width="25" height="30" rx="4" transform="rotate(-12 17.5 18)" fill={`url(#${id}-metal)`}/>
      <rect x="10" y="9" width="26" height="29" rx="4" fill={`url(#${id}-cover)`} stroke="#89c6f2" strokeWidth="0.6"/>
      <use href={`#${id}-m`} transform="translate(0 1)" fill="#163952"/>
      <use href={`#${id}-m`} fill={`url(#${id}-metal)`}/>
    </svg>
  );
}
