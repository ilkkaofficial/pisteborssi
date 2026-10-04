# Perheen säännöt ja unohtunut salasana

## Perheen säännöt

Avaa valikosta **Perheen säännöt**. Säännöt näkyvät myös Pistetilanteessa. Aluksi luettelo on tyhjä: sovellus ei keksi perheelle sääntöjä.

Vanhempi lisää säännölle otsikon (1–120 merkkiä) ja tarkan sisällön (1–4000 merkkiä). Molemmat ovat pakollisia. Kaikki kirjautuneet näkevät oletusarvoisesti vain otsikot: **1§ Otsikko**, **2§ Otsikko** jne. Otsikko aukeaa myös näppäimistöllä. Sisältö on tavallista tekstiä, ei HTML:ää.

Vanhempi voi muokata ja poistaa säännön näkyvistä. Poisto vahvistetaan; se ei poista pisteitä tai sääntöjen historiaa. Järjestys säilyy luontijärjestyksenä ja jäljelle jäävät säännöt numeroidaan uudelleen. Raja on 100 sääntöä poistettuine historioineen ja 100 muokkausta/sääntö. Yhteisen tietomäärän 2 MiB raja säilyy.

JSON-varmuuskopio sisältää säännöt ja niiden historian, ei salasanoja. V1–V4-tuonti yhdistää tiedot: puuttuvat säännöt eivät poista nykyisiä sääntöjä. Samat tunnisteet eivät kahdennu; ristiriita estää koko tuonnin.

## Vanhemman luoma tilapäinen salasana (toteutettu)

1. Oman aloitussalasanansa vaihtanut vanhempi avaa **Perhe ja tiedot**.
2. Valitse toisen aktiivisen perheenjäsenen kohdalla **Luo tilapäinen salasana**. Tämä toimii myös toiselle vanhemmalle.
3. Vahvista omalla nykyisellä salasanallasi. Syötä kohteen uusi 12–256 merkin tilapäinen salasana kahdesti.
4. Kerro salasana kohteelle turvallisesti. Sitä ei näytetä tallennuksen jälkeen eikä vanhaa salasanaa voi tarkistaa.
5. Kohteen kaikki aiemmat istunnot päättyvät. Hän kirjautuu tilapäisellä salasanalla ja vaihtaa sen omaan vähintään 12 merkin salasanaan ennen kirjauksia tai käyttäjähallintaa.

Vanhemman ja muiden käyttäjien istunnot säilyvät. Uuden käyttäjän 5–256 merkin aloitussalasanakäytäntö ja istunnon 365 päivän enimmäiskesto eivät muutu. Palautuksessa on 5 yrityksen / 15 minuutin turvaraja vanhempaa kohden eri laitteiden välillä; väärä oma salasana kuluttaa yrityksen. Raja ylitettynä odota 15 minuuttia ilman lisäyrityksiä.

Jos vastaus katoaa, käytä **Yritä tallennusta uudelleen** samalla sivulla. Sama pyyntö ei tee palautusta kahdesti. Epäselvän pyynnön salasanat säilyvät vain väliaikaisesti sivun muistissa uudelleenyritystä varten, eivät selaimen tallennuksessa tai lokissa. Älä lataa sivua ennen varmistusta. Samanaikainen kohteen salasanan muutos antaa ristiriitailmoituksen: tarkista tilanne ennen uutta palautusta.

## Muut ratkaisut ja pääsyn menetys

- **Toinen vanhempi auttaa**: toteutettu suositus myös oman salasanan unohtamiseen. Itseä ei voi palauttaa tällä toiminnolla.
- **Ylläpitäjän valvottu palautus**: molempien vanhempien menetettyä pääsyn omistaja varmistaa henkilöllisyyden ja auttaa erikseen. Ei julkista ohitusta tai automaattista kaikkien tilien nollausta.
- **Sähköpostilinkki tai kertakäyttöinen palautuskoodi**: mahdollisia myöhemmin, eivät kuulu tähän julkaisuun. Ne vaativat erillisen turvallisen toteutuksen ja vahvistetut yhteystiedot tai koodien säilytyksen.

## Julkaisu

Olemassa olevaan tietokantaan ajetaan vain `sql/2026-10-04-family-rules.sql` ennen uuden sovelluksen julkaisua. `sql/setup.sql` on vain tyhjään ensiasennukseen. Migraatio tarkistaa funktion tarkan lähtöhashin; odottamaton ero pysäyttää kaiken. `sql/check-family-rules.sql` validoi vain synteettistä JSON:ää read-only-transaktiossa.

Migraatio ei kirjoita sovelluksen tauluihin eikä muuta tilejä, salasanoja, istuntoja, pisteitä, RLS:ää tai grantteja. Tuotantotestit eivät nollaa oikeiden käyttäjien salasanoja eivätkä tee esimerkkipisteitä tai keksittyjä sääntöjä. Mock-testit eivät yksin todista Supabasen ajonaikaista toimintaa.
