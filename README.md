# Pistebörssi — yhteinen verkkoversio

Nykyinen mobiilikäyttöliittymä + Vercelin Node.js-API + Supabasen pysyvä Postgres-tietokanta. Kaikki kirjautuneet näkevät saman perheen kirjaukset ja saldot. Näkyvä sivu päivittyy noin 8 sekunnin välein sekä jokaisen tallennuksen jälkeen. Palvelin tarkistaa salasanat ja oikeudet; selaimessa ei ole erillistä pistetietokantaa tai paikallista kirjautumisvarajärjestelmää.

**Tämä toimitus ei muuta pilvijulkaisuasi tai luo tilejä tuotantotietokantaasi puolestasi.** Viisi tiliä syntyvät automaattisesti Vercelin palvelimella ensimmäisellä sovelluksen avauksella, kun uusi versio on julkaistu ja palvelinasetukset täytetty. Nodea ei tarvitse asentaa omalle Macille. Vanha paikallisprojekti säilyy erillisenä palautusta ja JSON-vientiä varten.

## Päivitä nykyinen GitHub/Vercel-julkaisu

1. Säilytä yksityiset JSON-varmuuskopiot ja nykyinen Supabase-tietokanta. Korvaa **nykyisen GitHub-repositorion** projektitiedostot tämän ZIPin sisällöllä (myös `.env.example` ja `.gitignore`). Tiedostot tulevat repositorion juureen; älä lisää ZIPiä tai ylimääräistä ulkokansiota.
2. Pidä Vercelissä ennallaan neljä toimivaa palvelinasetusta: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `APP_ORIGIN`, `RATE_LIMIT_SECRET`.
3. Lisää Vercelin **Production-ympäristön palvelinsalaisuudeksi** `INITIAL_USER_PASSWORD`. Syötä siihen itse haluamasi tilapäinen aloitussalasana Vercelin asetuksissa (5–256 merkkiä, enintään 1024 UTF-8-tavua). Älä kirjoita arvoa GitHubiin, `.env.example`-tiedostoon tai muihin projektitiedostoihin. Ei `NEXT_PUBLIC_`/`VITE_`-etuliitettä.
4. Tee nykyiseen Vercel-projektiin **Redeploy** ja avaa tuotanto-osoite. Palvelin alustaa **vain tyhjän tietokannan** viidellä alla luetellulla tilillä. Ensimmäinen avaus voi kestää muutaman sekunnin. Alustus ei tarvitse paikallista komentoa tai Node-asennusta.
5. Kirjaudu etunimellä → vaihda oma salasana vähintään 12-merkkiseksi → **Perhe ja tiedot / Lisää käyttäjä**. Ilkka tai Hanna voi valita **Lapsi / Vanhempi**, antaa nimen, yksilöllisen tunnuksen ja tilapäisen salasanan. Myös uudet käyttäjät vaihtavat salasanansa ennen kirjoituksia.
6. Kun alustus on valmis, poista `INITIAL_USER_PASSWORD` Vercelin asetuksista ja tee Redeploy. Alustettu sovellus toimii ilman sitä.

**Jo alustettu tietokanta:** päivitys, palvelinsalaisuuden muuttaminen tai Redeploy **ei nollaa eikä vaihda olemassa olevia tilejä, salasanoja, pisteitä tai maksuhistoriaa**. Kirjaudu olemassa olevilla salasanoilla. Puuttuvia vakiotilejä ei lisätä automaattisesti jo alustettuun tietokantaan; vanhempi lisää tarvittavat käyttäjät sovelluksesta. Älä tyhjennä tauluja saadaksesi aloitussalasanan voimaan.

**SQL:ää ei tarvitse ajaa uudelleen**, jos tämän projektin `sql/setup.sql` on jo suoritettu. Skeema ja RPC:t ovat ennallaan; SQL-tiedostossa muuttuvat vain kommentit. Uutta migraatiota ei tarvita. Jos SQL:ää ei ole vielä suoritettu, tee alla kuvattu ensiasennus samaan omaan Supabase-projektiin.

## 1. Vie ensin vanhat tiedot

**Vie JSON-varmuuskopiot ennen vanhan version korvaamista tai GitHubin projektitiedostojen päivittämistä — päivitys voi käynnistää Vercelin automaattijulkaisun.** Tee vienti kirjautuneena vanhempana **jokaisesta selaimesta/laitteesta**, jossa on kirjauksia. Vanha selainversio tallensi laitekohtaisesti; lähdekoodi tai ZIP ei sisällä näitä tietoja. Säilytä varmuuskopiot yksityisesti, **ei GitHubissa**.

## 2. Supabase ja SQL

1. Käytä omaa Supabase-projektiasi. Uutta projektia ei tarvita nykyisen julkaisun päivityksessä.
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
| `INITIAL_USER_PASSWORD` | Itse Verceliin syötettävä tilapäinen aloitussalasana; tarvitaan vain tyhjän tietokannan ensialustukseen |

`APP_ORIGIN` on nykyisen Vercel-projektisi tuotanto-osoite, jossa perhe käyttää sovellusta. Muut domainit ja preview-julkaisut eivät saa automaattisesti kirjoitusoikeutta; määritä erillinen ympäristö, jos testaat toisella domainilla. Älä nimeä salaisuuksia julkisilla `NEXT_PUBLIC_`/`VITE_`-etuliitteillä. Kun projektitiedostot ja palvelinasetukset on päivitetty, tee **nykyisessä Vercel-projektissa Redeploy** ja jatka tilien alustukseen alla.

Valinnainen vaihtoehto: voit käyttää erillistä uutta repositoriota ja Vercel-projektia esimerkiksi rinnakkaistestaukseen. Silloinkin JSON-viennit tehdään ennen vanhan version korvaamista, ja `APP_ORIGIN` asetetaan kyseisen julkaisun omaan osoitteeseen.

## 4. Viisi tiliä automaattisesti palvelimella

| Nimi | Käyttäjätunnus | Käyttäjätyyppi |
|---|---|---|
| Ilkka Paju | `ilkka` | Vanhempi |
| Hanna Hoffren | `hanna` | Vanhempi |
| Elli Paju | `elli` | Lapsi |
| Aava Paju | `aava` | Lapsi |
| Stella Paju | `stella` | Lapsi |

Tyhjän tietokannan viisi tiliä saavat `INITIAL_USER_PASSWORD`-palvelinsalaisuudessa määrittämäsi aloitussalasanan. Kullekin lasketaan oma satunnainen suola ja scrypt-tiiviste sekä `mustChange=true`. Aloitussalasana ei sisälly HTML:ään, lähdekoodiin, ZIPiin, SQL:ään, testeihin tai API-vastauksiin.

Alustus käyttää nykyistä `pb_initialize`-tietokantatapahtumaa ja lukkoa: samanaikaiset ensimmäiset avaukset eivät kahdenna tilejä eikä uudelleenjulkaisu korvaa olemassa olevia tietoja. Anonyymia käyttäjälistoja tai salasanoja vastaanottavaa alustusrajapintaa ei ole. Jos palvelinsalaisuus puuttuu tai on virheellinen tyhjässä tietokannassa, käyttöliittymä kertoo tarvittavan Vercel-asetuksen ilman salaista arvoa.

Jokainen kirjautuu HTTPS-julkaisuun omalla etunimellään ja vaihtaa aloitussalasanansa **ennen pisteitä, maksukuittauksia tai käyttäjähallintaa**. Käyttäjätunnuksen kirjainkoko ja reunavälilyönnit eivät vaikuta; salasana tarkistetaan täsmälleen kirjoitettuna. Uusi oma salasana on aina **12–256 merkkiä, enintään 1024 UTF-8-tavua**. Tilapäinen salasana voi olla 5–256 merkkiä, mutta lyhyt salasana ei kelpaa uudeksi omaksi salasanaksi. Vanhoja paikallisia salasanoja tai tiivisteitä ei siirretä.

Tämän jälkeen yhteisen tietokannan merkki näkyy käyttöliittymässä. Pelkkä HTML:n avaaminen tiedostona ei voi korvata palvelin-API:a.

### Valinnainen edistyneen käyttäjän paikallinen alustus

Vanha `scripts/bootstrap.mjs` toimii edelleen vaihtoehtona **vielä tyhjään** tietokantaan. Tämä ei ole tarpeen tavallisessa käyttöönotossa. Jos valitset sen, käytä Node 22:ta ja paikallisia palvelinasetuksia `.env`-tiedostossa (Gitin ulkopuolella):

```sh
node --env-file=.env scripts/bootstrap.mjs
```

Ohjelma kysyy viisi etunimitunnusta ja kullekin erillisen 12–256 merkin salasanan piilotetusti sekä vahvistuksen. Jo alustettu tietokanta hylätään ennen kysymyksiä; mitään olemassa olevaa ei muuteta. Älä aja paikallista alustusta samaan aikaan palvelinautomaation kanssa.

## 5. Yhdistä vanha historia

Kirjaudu verkkoversioon vanhempana → **Perhe ja tiedot** → tuo vanhan version V1/V2/V3-JSON (myös uuden version V4 käy). Esikatselu näyttää lisättävät henkilöt/kirjaukset, samanlaiset tunnisteet ja ristiriidat. Vahvista vasta tarkistuksen jälkeen.

- IDs, aikaleimat, maksukuitit, poistot ja muutoshistoria säilyvät.
- Samat tunnisteet ja samat tiedot ohitetaan ilman kahdentamista.
- Ristiriitainen sama ID **estää koko tuonnin**: korjaa lähde tai yhteiset tiedot tarkoituksellisesti ja esikatsele uudelleen. Mitään ei ylikirjoiteta hiljaisesti.
- Paikalliset salasanat, tiivisteet, sähköpostit ja tunnuskartoitukset jätetään pois. Olemassa olevat verkkotilit eivät muutu. Tuoduille uusille henkilöille vanhempi voi luoda uuden verkkotunnuksen; arkistoitu henkilö palautetaan ensin.
- Tuo kaikkien vanhojen laitteiden varmuuskopiot samalla tavalla. Tuontiraja on 2 MiB; ledgerin rajat ovat 200 henkilöä / 20 000 kirjausta / 2 MiB. Liian suuri aineisto hylätään muuttamatta tietoja.

## Turvallisuus ja toimintarajat

Suolattu scrypt, palvelinroolit, 365 päivän laitekohtainen HttpOnly/Secure/SameSite-istunto, saman alkuperän ja CSRF-tunnisteen tarkistus sekä tietokantaan tallennetut kirjautumisyritysrajat. Salasananvaihto mitätöi kaikki vanhat istunnot. Vain vanhemmat kuittaavat maksuja, korjaavat historiaa ja hallitsevat perhettä; viimeistä kirjautuvaa vanhempaa ei voi arkistoida.

CAS/revision ja idempotenssi suojaavat samanaikaisia kirjauksia sekä maksukuitteja. Idempotenssiavain säilyy uudelleenyrityksessä; pysyviä avaimia ei vanhenneta. Tulostietueet sisältävät operaation metatiedot, eivät kopioita koko ledgeristä. Seuraa silti Supabasen tallennus- ja käyttörajoja.

Yhteyskatkoa ei peitetä paikallistallennuksella. Jos tallennuksen tulos jää epäselväksi, käytä **Yritä tallennusta uudelleen** -painiketta; älä tee uutta maksukuittausta tai lataa sivua ennen tuloksen varmistusta. 5 € kuittaus vahvistaa jo maksetun rahan ja vähentää 10 pistettä — ei rahansiirtoa.

## Tarkistukset

```sh
npm test
```

Node-testit kutsuvat oikeaa API-/palvelin-/Supabase-adapterikoodia **mockatulla Supabase-RPC-rajapinnalla**, eivät tuotantotietokannalla. Ne kattavat viiden tilin automaattialustuksen, yksilölliset suolat, lyhyen tilapäisen salasanan ja pakollisen vähintään 12 merkin vaihdon, rinnakkaiset käynnistykset, tietojen säilymisen ja asetuksen poistamisen sekä kummankin vanhemman lapsi-/vanhempitilien luonnin. Myös yhteiset istunnot, maksujen idempotenssi, roolit, CSRF/origin, tuonti ja yhteysvirheet testataan. Testisalasanat arvotaan ajonaikaisesti. Selaimen integraatiotestissä käytetään vain valmiiksi saatavilla olevaa Playwrightia/selainta; mitään ei tarvitse asentaa.

Tämän päivityksen tarkistukset: **35/35 testiä läpäisi, ei ohitettuja testejä** (33 palvelin-/SQL-staattista testiä ja kaksi valmiilla Chromiumilla ajettua selainintegraatiotestiä). Selain tarkisti 320–844 pikselin näkymät, yhteisnäkyvyyden, maksuhistorian, kummankin vanhemman käyttäjähallinnan, näppäimistökäytön ja ensisalasanan vaihdon. HTML-validaattori: ei virheitä, varoituksia tai ulkoisia omaisuusviittauksia.

Oikeaa Supabase/Vercel-yhteyttä tai fyysisiä iPhone-/Android-laitteita ei ollut. SQL:ää ei ajettu oikeassa Postgresissa eikä tuotantotilejä luotu tämän toimituksen aikana. **Käyttöönotossa varmista nykyinen SQL ja Node 22/Vercel -integraatio**, sitten testaa kahdella eri selaimella/laitteella: kirjaus näkyy toisella noin 8 sekunnissa, samanaikaiset kirjaukset säilyvät, maksu ei kahdennu, lapsi ei voi käyttää vanhempitoimintoja, vanha JSON ei kahdennu uudelleentuonnissa ja yhteyskatko näkyy virheenä.

Ohjeet: [Vercelin Node-funktiot](https://vercel.com/docs/functions/runtimes/node-js), [Node-määritykset](https://vercel.com/docs/functions/runtimes/node-js/advanced-node-configuration), [Supabase API](https://supabase.com/docs/guides/api), [API-avaimet](https://supabase.com/docs/guides/getting-started/api-keys), [uudet avaimet](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys).


### Käyttöliittymä- ja istuntopäivitys
- Laitekohtainen istunto on enintään 365 päivää ja päättyy uloskirjautumiseen, istunnon vanhenemiseen tai salasanan vaihtoon.
- Pistebörssi voidaan lisätä iPhonen Koti-valikkoon. Kirjaudu ensimmäisen kerran nimenomaan Koti-valikosta avatussa sovelluksessa.
- Päänäkymässä näkyy kaikkien lasten pistetilanne. Muut näkymät, salasanan vaihto ja uloskirjautuminen ovat hampurilaisvalikossa.
- Päivitys ei suorita SQL:ää, alustusta eikä muuta nykyistä Supabase-tietokantaa, tilejä tai salasanoja.
