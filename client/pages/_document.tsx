import { Html, Head, Main, NextScript } from 'next/document';
import { Router } from 'next/router';
import { useEffect, useState } from 'react';

export default function Document() {
  useEffect(() => {
    Router.events.on('routeChangeComplete', (url) => {
      try {
        // @ts-ignore
        window._hmt.push(['_trackPageview', url]);
      } catch (e) {}
    });
  }, []);
  return (
    <Html lang='en'>
      <Head />

      <link rel='shortcut icon' href='/img/favicon.png' />

      <meta
        name='description'
        content='A real-time multiplayer game built with Nextjs Socket.IO'
      />
      <meta name='keywords' content='Generals, multiplayer-game'></meta>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
