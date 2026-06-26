import '../styles/globals.css';
import type { AppProps } from 'next/app';
import { appWithTranslation, useTranslation } from 'next-i18next';
import Head from 'next/head';
// import Snowflakes from 'magic-snowflakes';
// import { useEffect } from 'react';

function App({ Component, pageProps }: AppProps) {
  const { t } = useTranslation();
  // useEffect(() => {
  //   const snowflakes = new Snowflakes();
  //   snowflakes.start();
  // }, []);
  return (
    <>
      <Head>
        <title>{t('site-name')}</title>
      </Head>
      <Component {...pageProps} />
    </>
  );
}

export default appWithTranslation(App);
