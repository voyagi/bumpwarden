# Mockups

All six pages, built to [../ART-DIRECTION.md](../ART-DIRECTION.md). Open any `.html` directly or
serve the folder. They share [../../public/bumpwarden.css](../../public/bumpwarden.css), which is
the one design system the running app serves as well: change a token there and every page follows,
mockup and product alike. The two typefaces are served from that same folder, so neither a mockup
nor a page view reaches a third party.

The content is real. Package names, versions and publish dates come from the npm registry, and the
Express 5 quotes come from the
[official migration guide](https://expressjs.com/en/guide/migrating-5.html). Nothing here is
placeholder copy.

| Page        | Desktop 1440                                     | Mobile 390                                     |
| ----------- | ------------------------------------------------ | ---------------------------------------------- |
| Home        | [bw-home-desktop.png](bw-home-desktop.png)       | [bw-home-mobile.png](bw-home-mobile.png)       |
| Queue       | [bw-project-desktop.png](bw-project-desktop.png) | [bw-project-mobile.png](bw-project-mobile.png) |
| Bump detail | [bw-bump-desktop.png](bw-bump-desktop.png)       | [bw-bump-mobile.png](bw-bump-mobile.png)       |
| Audit       | [bw-audit-desktop.png](bw-audit-desktop.png)     | [bw-audit-mobile.png](bw-audit-mobile.png)     |
| Rubric      | [bw-rubric-desktop.png](bw-rubric-desktop.png)   | [bw-rubric-mobile.png](bw-rubric-mobile.png)   |
| About       | [bw-about-desktop.png](bw-about-desktop.png)     | [bw-about-mobile.png](bw-about-mobile.png)     |

## Verified, not assumed

- **Zero horizontal overflow** on every page at 390px, measured in a real browser.
- **Mona Sans resolves** on every page. Checked against the computed style rather than the
  stylesheet, so a silent fallback would have been caught.
- **Contrast measured in both themes** against the values the browser actually resolves. Every text
  colour clears 4.5:1 on its panel and every colour used only as a bar or a pin clears 3:1. Two
  failures were found this way and fixed: the label grey missed AA in both themes.
- The dark theme follows `prefers-color-scheme` and lifts the risk ramp so each step keeps its
  contrast. The meaning of a step never changes, only its luminance.
