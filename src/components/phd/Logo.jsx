import { Image } from '@/components/ui/image';
const logos = {
  clean: 'https://media.base44.com/images/public/user_6a021f6425897ae30c93a46b/fd859ce17_ImagemdoChatGPT26desetde202611_01_37.png',
  dark: 'https://media.base44.com/images/public/user_6a021f6425897ae30c93a46b/1e0fc687a_ImagemdoChatGPT26desetde202610_59_52.png'
};
export default function Logo({ theme = 'clean', className = '' }) {
  return <Image src={logos[theme]} fittingType="fit" alt="PHD Engenharia | 360 | 4D" className={`phd-logo ${className}`} />;
}