# Pistebörssi — yhteinen verkkoversio

Nykyinen mobiilikäyttöliittymä + Vercelin Node.js-API + Supabasen pysyvä Postgres-tietokanta. Kaikki kirjautuneet näkevät saman perheen kirjaukset ja saldot. Näkyvä sivu päivittyy noin 8 sekunnin välein sekä jokaisen tallennuksen jälkeen. Palvelin tarkistaa salasanat ja oikeudet; selaimessa ei ole erillistä pistetietokantaa tai paikallista kirjautumisvarajärjestelmää.

**Tämä projektitoimitus ei ole vielä kytketty sinun tileihisi tai aktivoitu aiempaan Vercel-julkaisuusi.** Ilman seuraavia asetuksia sovellus näyttää yhteys-/alustusvirheen. Vanha paikallisprojekti säilyy erillisenä palautusta ja JSON-vientiä varten.

## 1. Vie ensin vanhat tiedot

**Vie JSON-varmuuskopiot ennen vanhan version korvaamista tai GitHubin projektitiedostojen päivittämistä — päivitys voi käynnistää Vercelin automaattijulkaisun.** Tee vienti kirjautuneena vanhempana **jokaisesta selaimesta/laitteesta**, jossa on kirjauksia. Vanha selainversio tallensi laitekohtaisesti; lähdekoodi tai ZIP ei sisällä näitä tietoja. Säilytä varmuuskopiot yksityisesti, **ei GitHubissa**.

## 2. Supabase ja SQL

1. Luo oma, uusi Supabase-projekti.
2. Avaa SQL Editor ja suorita koko `sql/setup.sql` omistajana. Se luo ledgerin, tilit, istunnot, yritysrajat, tuontiesikatselut ja idempotenssitiedot. Tauluilla on RLS eikä `anon`/`authenticated`-luku- tai kirjoitusoikeuksia; RPC:t ovat vain palvelinroolille. Älä lisää julkisia käytäntöjä tai oikeuksia.
3. Ota projektin HTTPS-URL ja **uusi palvelimen secret-avain** (`sb_secret_…`) talteen. Älä käytä selaimessa anon-avainta tai lisää avainta lähdekoodiin. Palvelin käyttää secret-avainta `apikey`-otsakkeessa, ei JWT-bearerina.

## 3. GitHub ja Vercel

**Käytä ensisijaisesti nykyistä GitHub-repositoriotasi ja nykyistä toimivaa Vercel-projektiasi. Uutta repositoriota tai Vercel-projektia ei tarvitse luoda.**

Varmista ensin kohdan 1 JSON-viennit. Pura tämä ZIP ja päivitä **nykyisen GitHub-repositorion** projektitiedostot ZIPin sisällöllä repositorion juuressa, myös `.gitignore` ja `.env.example`. Älä lisää pelkkää ZIP-tiedostoa tai ylimääräistä ulkokansiota. Säilytä nykyinen repo–Vercel-kytkentä. Suositus: yksityinen repo. Älä vie vanhoja varmuuskopioita tai oikeaa `.env`-tiedostoa. Lisenssiä ei ole lisätty puolestasi.

Tarkista **nykyisen Vercel-projektin** asetukset:

- Root Directory: repositorion juuri.
- Framework Preset: **Other**.
- Build Command: tyhjä; Output Directory: **public**.
- `api/pisteborssi.js` on Node-funktio; `package.json` valitsee ESM:n ja Node 22:n. Ei pakettiriippuvuuksia tai `server.listen()`-palvelinta.

Lisää tai päivitä seuraavat arvot **nykyisen Vercel-projektin Production-ympäristön palvelinasetuksissa**, ei repositoriossa tai selaimessa:

| Muuttuja | Arvo |
|---|---|
| `SUPABASE_URL` | Oman projektin `https://…supabase.co` |
| `SUPABASE_SECRET_KEY` | Oma `sb_secret_…`-palvelinavain |
| `APP_ORIGIN` | Täsmälleen tuotannon HTTPS-alkuperä, esim. oma Vercel-domain ilman loppuviivaa |
| `RATE_LIMIT_SECRET` | Oma kryptografisesti satunnainen salaisuus, suositus 64 satunnaista heksamerkkiä |

`APP_ORIGIN` on nykyisen Vercel-projektisi tuotanto-osoite, jossa perhe käyttää sovellusta. Muut domainit ja preview-julkaisut eivät saa automaattisesti kirjoitusoikeutta; määritä erillinen ympäristö, jos testaat toisella domainilla. Älä nimeä salaisuuksia julkisilla `NEXT_PUBLIC_`/`VITE_`-etuliitteillä. Kun projektitiedostot ja palvelinasetukset on päivitetty, tee **nykyisessä Vercel-projektissa Redeploy** ja jatka tilien alustukseen alla.

Valinnainen vaihtoehto: voit käyttää erillistä uutta repositoriota ja Vercel-projektia esimerkiksi rinnakkaistestaukseen. Silloinkin JSON-viennit tehdään ennen vanhan version korvaamista, ja `APP_ORIGIN` asetetaan kyseisen julkaisun omaan osoitteeseen.

## 4. Alusta viisi tiliä turvallisesti

Omalla koneella tarvitaan Node 22 tai uudempi, ei riippuvuuksien asentamista.

1. Kopioi `.env.example` paikalliseksi `.env`-tiedostoksi ja täytä samat palvelinasetukset. `.env` on Gitin ulkopuolella.
2. Aja projektin juuressa paikallisessa interaktiivisessa päätteessä:
   ```sh
   node --env-file=.env scripts/bootstrap.mjs
   ```
3. Hyväksy etunimitunnukset Enterillä: **ilkka, hanna, elli, aava, stella**. Anna jokaiselle yksilöllinen vahva 12–256 merkin aloitussalasana ja vahvista se piilotetussa kehotteessa. Salasanoja ei näytetä, kirjoiteta lähdekoodiin tai lueta komentoriviargumenteista.
4. Alustus tekee kaikki viisi tiliä yhtenä tietokantatapahtumana. Uudelleenajo **ei nollaa olemassa olevia tilejä**. Ilkka Paju ja Hanna Hoffren ovat vanhempia; muut lapsia.
5. Jokainen kirjautuu HTTPS-julkaisuun omalla etunimellään ja vaihtaa aloitussalasanansa **ennen kirjauksia**. Kirjainkoko ja reunavälilyönnit eivät vaikuta. Vanhoja paikallisia salasanoja tai tiivisteitä ei siirretä automaattisesti.

Tämän jälkeen yhteisen tietokannan merkki näkyy käyttöliittymässä. Pelkkä HTML:n avaaminen tiedostona ei voi korvata palvelin-API:a.

## 5. Yhdistä vanha historia

Kirjaudu verkkoversioon vanhempana → **Perhe ja tiedot** → tuo vanhan version V1/V2/V3-JSON (myös uuden version V4 käy). Esikatselu näyttää lisättävät henkilöt/kirjaukset, samanlaiset tunnisteet ja ristiriidat. Vahvista vasta tarkistuksen jälkeen.

- IDs, aikaleimat, maksukuitit, poistot ja muutoshistoria säilyvät.
- Samat tunnisteet ja samat tiedot ohitetaan ilman kahdentamista.
- Ristiriitainen sama ID **estää koko tuonnin**: korjaa lähde tai yhteiset tiedot tarkoituksellisesti ja esikatsele uudelleen. Mitään ei ylikirjoiteta hiljaisesti.
- Paikalliset salasanat, tiivisteet, sähköpostit ja tunnuskartoitukset jätetään pois. Olemassa olevat verkkotilit eivät muutu. Tuoduille uusille henkilöille vanhempi voi luoda uuden verkkotunnuksen; arkistoitu henkilö palautetaan ensin.
- Tuo kaikkien vanhojen laitteiden varmuuskopiot samalla tavalla. Tuontiraja on 2 MiB; ledgerin rajat ovat 200 henkilöä / 20 000 kirjausta / 2 MiB. Liian suuri aineisto hylätään muuttamatta tietoja.

## Turvallisuus ja toimintarajat

Suolattu scrypt, palvelinroolit, 12 tunnin HttpOnly/Secure/SameSite-istunto, saman alkuperän ja CSRF-tunnisteen tarkistus sekä tietokantaan tallennetut kirjautumisyritysrajat. Salasananvaihto mitätöi kaikki vanhat istunnot. Vain vanhemmat kuittaavat maksuja, korjaavat historiaa ja hallitsevat perhettä; viimeistä kirjautuvaa vanhempaa ei voi arkistoida.

CAS/revision ja idempotenssi suojaavat samanaikaisia kirjauksia sekä maksukuitteja. Idempotenssiavain säilyy uudelleenyrityksessä; pysyviä avaimia ei vanhenneta. Tulostietueet sisältävät operaation metatiedot, eivät kopioita koko ledgeristä. Seuraa silti Supabasen tallennus- ja käyttörajoja.

Yhteyskatkoa ei peitetä paikallistallennuksella. Jos tallennuksen tulos jää epäselväksi, käytä **Yritä tallennusta uudelleen** -painiketta; älä tee uutta maksukuittausta tai lataa sivua ennen tuloksen varmistusta. 5 € kuittaus vahvistaa jo maksetun rahan ja vähentää 10 pistettä — ei rahansiirtoa.

## Tarkistukset

```sh
npm test
```

Node-testit kutsuvat oikeaa API-/palvelin-/Supabase-adapterikoodia **mockatulla Supabase-RPC-rajapinnalla**, eivät tuotantotietokannalla. Ne kattavat yhteiset istunnot, samanaikaisuuden, maksujen idempotenssin, roolit, CSRF/origin-tarkistukset, salasananvaihdon, tuonnin ja virheet. Selaimen integraatiotestissä käytetään valmiiksi saatavilla olevaa Playwrightia; jos sitä ei ole, kyseinen testi merkitään ohitetuksi.

Tämän toimituksen yhteydessä ei ollut oikeaa Supabase/Vercel-yhteyttä tai iPhone-/Android-laitteita. SQL:ää ei ajettu oikeassa Postgresissa; Node-testien käytettävissä ollut runtime oli Node 24. **Käyttöönotossa varmista SQL ja Node 22/Vercel -integraatio**, sitten testaa kahdella eri selaimella/laitteella: kirjaus näkyy toisella noin 8 sekunnissa, samanaikaiset kirjaukset säilyvät, maksu ei kahdennu, lapsi ei voi käyttää vanhempitoimintoja, vanha JSON ei kahdennu uudelleentuonnissa ja yhteyskatko näkyy virheenä.

Ohjeet: [Vercelin Node-funktiot](https://vercel.com/docs/functions/runtimes/node-js), [Node-määritykset](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration), [Supabase API](https://supabase.com/docs/guides/api), [API-avaimet](https://supabase.com/docs/guides/getting-started/api-keys), [uudet avaimet](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys).
