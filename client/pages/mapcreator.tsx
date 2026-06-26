import { serverSideTranslations } from 'next-i18next/serverSideTranslations';
import { useTranslation } from 'next-i18next';
import { ThemeProvider } from '@mui/material/styles';
import Navbar from '../components/Navbar';
import theme from '../components/theme';
import MapEditor from '@/components/game/MapEditor';
import Head from 'next/head';

export default function Home() {
  const { t } = useTranslation();
  return (
    <ThemeProvider theme={theme}>
      <Head>
        <title>{t('page-title-map-creator')} | {t('site-name')}</title>
      </Head>
      <Navbar />
      <MapEditor editMode={true} />
    </ThemeProvider>
  );
}

export async function getStaticProps(context: any) {
  // extract the locale identifier from the URL
  const { locale } = context;

  return {
    props: {
      // pass the translation props to the page component
      ...(await serverSideTranslations(locale)),
    },
  };
}
