# Pistebörssi

Kevyt, staattinen verkkosovellus. `public/index.html` on aiemmin toimitetun Pistebörssin täydellinen, muuttamaton lähdekoodi: kaikki CSS ja selain-JavaScript ovat samassa tiedostossa. Pakettiriippuvuuksia, palvelinta tai build-vaihetta ei tarvita.

## Tiedostot

```text
public/index.html
README.md
vercel.json
.gitignore
```

ZIP sisältää nämä neljä tiedostoa suoraan arkiston juuressa ja `public/`-alikansiossa. GitHub-repositorion juureen tulee tämä sisältö, ei ZIP-tiedosto eikä ylimääräinen projektikansio.

## Paikallinen käyttö

Avaa `public/index.html` ajantasaisessa selaimessa. Sovellus tarvitsee JavaScriptin ja Web Crypto -tuen; OneDrive- tai muu tiedostoesikatselu ei välttämättä suorita sitä. Kirjautumistunnukset ovat Ilkka, Hanna, Elli, Aava ja Stella. Käytä perheen erikseen sopimaa salasanaa; sitä ei dokumentoida projektissa.

## GitHubiin

1. Luo GitHubissa **yksityinen (Private)** repositorio.
2. Pura ZIP ja lisää kaikki neljä tiedostoa yllä olevassa rakenteessa repositorion juureen. Näytä tarvittaessa piilotetut tiedostot, jotta myös `.gitignore` tulee mukaan.
3. Tarkista ennen tallennusta, ettei mukana ole henkilökohtaisia JSON-varmuuskopioita, salaisia asetuksia tai testitietoa. `.gitignore` ei poista jo Gitissä olevia tiedostoja eikä salaa tietoja.

## Vercel Hobbyyn

1. Valitse Vercelissä uuden projektin tuonti GitHubista ja tämä repositorio.
2. **Root Directory:** repositorion juuri, ei `public`-alikansio.
3. **Framework Preset:** `Other`. **Build Command:** tyhjä, ei build-vaihetta. **Output Directory:** `public`.
4. Julkaise ja avaa saatu HTTPS-osoite. `vercel.json` määrittää julkaisukansioksi `public`.

Viralliset ohjeet: [staattiset julkaisut ja buildit](https://vercel.com/docs/builds), [build-asetukset ja public-kansio](https://vercel.com/docs/builds/configure-a-build).

## Tärkeät tietojen ja kirjautumisen rajaukset

- Tämä on **paikallinen selainkirjautuminen ja selaintallennus**, ei turvallinen palvelinpuolinen tunnistautuminen eikä perheen laitteiden yhteinen tietokanta. Hosting ei muuta tätä. Tiedostoa tai selaintietoja muokkaamalla käyttöoikeuksia voi kiertää.
- Yksityinen GitHub-repo on suositus, mutta Vercel-osoite voi silti olla julkinen. Sovelluksen kirjautumisnäkymä ei suojaa julkisen julkaisun lähdekoodia tai muodosta todellista palvelinpuolen käyttöoikeussuojaa.
- Projektissa ovat sovelluksen nykyiset nimet ja alkuperäiset suolatut alustustiivisteet. Henkilöiden sähköpostiosoitteita, selväkielisiä salasanoja, henkilökohtaisia varmuuskopioita tai testitietoa ei ole mukana.
- **GitHub ja ZIP eivät sisällä selaimessa syntyneitä pistekirjauksia, maksukuitteja tai käyttäjän vaihtamia salasanoja.** Ne ovat selaintallennuksessa avaimella `pisteborssi-v1`; uudessa versiossa varmuuskopion tietomuoto on V3.
- Uusi selain tai julkaisuosoite aloittaa lähdekoodin oletustiedoista. Vie tarvittaessa vanhassa sovelluksessa kirjautuneena vanhempana JSON-varmuuskopio ja palauta se uuden osoitteen **Perhe ja tiedot** -näkymässä. V1/V2/V3-palautukset ovat tuettuja. Pidä tämä henkilökohtainen varmuuskopio erillään projektista ja GitHubista.
- Tiedot eivät synkronoidu laitteiden välillä. Selaintietojen tyhjentäminen tai yksityistilan sulkeminen voi hävittää ne. Maksukuittaus vahvistaa jo suoritetun maksun; sovellus ei siirrä rahaa.

Tähän pakettiin ei ole lisätty lisenssiä. Paketin valmistelu ei itsessään julkaise mitään GitHubiin tai Verceliin.
