// @ts-check
import react from '@astrojs/react'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

const repo = 'https://github.com/vmaerten/diffdesk'

export default defineConfig({
  site: 'https://diffdesk.vmaerten.fr',
  integrations: [
    react(),
    starlight({
      title: 'Diffdesk',
      description: 'Review the PR you are about to open, without opening it.',
      logo: { src: './public/favicon.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/theme.css',
      ],
      sidebar: [
        {
          label: 'Guide',
          items: [
            { label: 'Getting started', slug: 'guide/getting-started' },
            { label: 'Installation', slug: 'guide/installation' },
            { label: 'Reviewing code', slug: 'guide/reviewing' },
            { label: 'Keyboard shortcuts', slug: 'guide/shortcuts' },
          ],
        },
        { label: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md`, attrs: { target: '_blank' } },
      ],
    }),
  ],
})
