#!/usr/bin/env node
/**
 * Aplica rosters finais oficiais do ESPN ao squads.json
 * (https://www.espn.com/soccer/story/_/id/48757621)
 *
 * Seleções com Final Roster Announced (inclui Argentina 28/05 e Panama 26/05).
 * Outros (Canada, Australia, Ecuador, Iraq, Algeria, Saudi Arabia, Uruguay,
 * Uzbekistan, Colombia, Croatia, Ghana, England) ficam como estão.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQUADS_PATH = join(__dirname, '..', 'assets', 'data', 'squads.json');

// ESPN team name → squads.json key (which is API style)
const TEAM_MAP = {
  'United States': 'USA',
  'Cape Verde': 'Cape Verde Islands',
  'Curacao': 'Curaçao',
  'Czechia': 'Czech Republic',
  'Bosnia-Herzegovina': 'Bosnia & Herzegovina',
};

const POS_MAP = { Goalkeepers: 'GOL', Defenders: 'DEF', Midfielders: 'MEI', Forwards: 'ATA' };

// Nomes que NÃO podem virar inicial (colidiriam com outro jogador do mesmo time).
// Ex.: Lisandro e Lautaro Martínez ambos virariam "L. Martínez" (Argentina).
const KEEP_FULL = new Set([
  'Lisandro Martínez',                          // Argentina (vs Lautaro Martínez)
  'Douglas Santos', 'Danilo Santos',            // Brazil
  'Edson Álvarez', 'Efrain Álvarez',            // Mexico
  'Mohannad Abu Taha', 'Mohammad Abu Taha',     // Jordan
  'Alan Benitez', 'Alcides Benitez',            // Paraguay
  'Mario Pašalić', 'Marco Pašalić',             // Croatia (não está no ESPN, mas documenta a colisão)
]);

// Converte "Cristiano Ronaldo" → "C. Ronaldo". Monônimos preservados.
function toInitial(fullName) {
  if (KEEP_FULL.has(fullName)) return fullName;
  if (!fullName.includes(' ')) return fullName;
  const parts = fullName.split(' ');
  const first = parts[0];
  const last = parts.slice(1).join(' ');
  return `${first.charAt(0).toUpperCase()}. ${last}`;
}

// ===== ESPN data (35 final rosters) =====
const ESPN = {
  // Final 26 — CNN Brasil (01/06/2026)
  Mexico: {
    Goalkeepers: ['Carlos Acevedo','Guillermo Ochoa','Raúl Rangel'],
    Defenders: ['César Montes','Edson Álvarez','Israel Reyes','Jesús Gallardo','Johan Vásquez','Jorge Sánchez','Mateo Chávez'],
    Midfielders: ['Álvaro Fidalgo','Brian Gutiérrez','Luis Romo','Erik Lira','Gilberto Mora','Luis Chávez','Obed Vargas','Orbelín Pineda'],
    Forwards: ['Alexis Vega','Armando González','César Huerta','Guillermo Martínez','Julián Quiñones','Raúl Jiménez','Roberto Alvarado','Santiago Giménez'],
  },
  'South Africa': {
    Goalkeepers: ['Ronwen Williams','Ricardo Goss','Sipho Chaine'],
    Defenders: ['Khuliso Mudau','Nkosinathi Sibisi','Ime Okon','Khulumani Ndamane','Aubrey Modiba','Samukelo Kabini','Thabang Matuludi','Olwethu Makhanya','Kamgogelo Sebelebele','Bradley Cross','Mbekezeli Mbokazi'],
    Midfielders: ['Teboho Mokoena','Thalente Mbatha','Yaya Sithole','Jayden Adams'],
    Forwards: ['Oswin Appollis','Iqraam Rayners','Tshepang Moremi','Relebohile Mofokeng','Evidence Makgopa','Themba Zwane','Lyle Foster','Thapelo Maseko'],
  },
  'South Korea': {
    Goalkeepers: ['Jo Hyun-Woo','Kim Seung-Gyu','Song Bum-Keun'],
    Defenders: ['Kim Min-Jae','Jo Yu-Min','Lee Han-Beom','Kim Tae-Hyun','Park Jin-Seop','Lee Ki-Hyeok','Lee Tae-Seok','Seol Young-Woo','Jens Castrop','Kim Moon-Hwan'],
    Midfielders: ['Yang Hyun-Jun','Paik Seung-Ho','Hwang In-Beom','Kim Jin-Kyu','Bae Jun-Ho','Um Ji-Sung','Hwang Hee-Chan','Lee Dong-Gyeong','Lee Jae-Sung','Lee Kang-In'],
    Forwards: ['Oh Hyun-Kyu','Son Heung-Min','Cho Kyu-Sung'],
  },
  // Final 26 — CNN Brasil (01/06/2026)
  Czechia: {
    Goalkeepers: ['Lukas Hornicek','Matej Kovar','Jindrich Stanek'],
    Defenders: ['Vladimír Coufal','David Douděra','Tomáš Holeš','Robin Hranáč','David Jurásek','Štěpán Chaloupek','Ladislav Krejčí','Jaroslav Zelený','David Zima'],
    Midfielders: ['Lukás Cerv','Vladimir Darida','Lukás Provod','Michal Sadílek','Hugo Sochůrek','Alexandr Sojka','Tomáš Souček','Pavel Šulc','Denis Višinský'],
    Forwards: ['Adam Hložek','Tomáš Chorý','Mojmír Chytil','Jan Kuchta','Patrik Schick'],
  },
  'Bosnia-Herzegovina': {
    Goalkeepers: ['Nikola Vasilj','Martin Zlomislic','Osman Hadzikic'],
    Defenders: ['Sead Kolasinac','Amar Dedic','Nihad Mujakic','Nikola Katic','Tarik Muharemovic','Stjepan Radeljic','Dennis Hadzikadunic','Nidal Celik'],
    Midfielders: ['Amir Hadziahmetovic','Ivan Sunjic','Ivan Basic','Dzenis Burnic','Ermin Mahmic','Benjamin Tahirovic','Amar Memic','Armin Gigovic','Kerim Alajbegovic','Esmir Bajraktarevic'],
    Forwards: ['Ermedin Demirovic','Jovo Lukic','Samed Bazdar','Haris Tabakovic','Edin Dzeko'],
  },
  Qatar: {
    Goalkeepers: ['Shehab Elleithy','Salah Zakaria','Meshaal Barsham','Mahmoud Abunada'],
    Defenders: ['Boualem Khoukhi','Pedro Miguel','Sultan Al Brake','Tarek Salman','Al-Hashmi Al-Hussain','Ayoub Al-Alawi','Bassam Al-Rawi','Rayyan Al-Ali','Issa Laye','Lucas Mendes','Mohammed Waad','Niall Mason'],
    Midfielders: ['Ahmed Fathi','Jassim Gaber','Assim Madibo','Abdulaziz Hatem','Karim Boudiaf','Mohammed Mannai','Homam Al-Amin'],
    Forwards: ['Almoez Ali','Akram Afif','Tahsin Mohammed','Edmílson Junior','Ahmed Al-Ganehi','Ahmed Alaa','Sebastián Soria','Hassan Al-Haydos','Mubarak Shannan','Mohammed Muntari','Yusuf Abdurisag'],
  },
  Switzerland: {
    Goalkeepers: ['Gregor Kobel','Yvon Mvogo','Marvin Keller'],
    Defenders: ['Manuel Akanji','Nico Elvedi','Ricardo Rodriguez','Silvan Widmer','Miro Muheim','Aurèle Amenda','Eray Cömert','Luca Jaquez'],
    Midfielders: ['Granit Xhaka','Johan Manzambi','Remo Freuler','Denis Zakaria','Ardon Jashari','Djibril Sow','Christian Fassnacht','Michel Aebischer','Fabian Rieder','Rubén Vargas'],
    Forwards: ['Breel Embolo','Noah Okafor','Dan Ndoye','Zeki Amdouni','Cedric Itten'],
  },
  Brazil: {
    Goalkeepers: ['Alisson','Éderson','Weverton'],
    Defenders: ['Alex Sandro','Bremer','Danilo','Douglas Santos','Gabriel Magalhães','Léo Pereira','Marquinhos','Roger Ibañez','Wesley'],
    Midfielders: ['Bruno Guimarães','Casemiro','Danilo Santos','Fabinho','Lucas Paquetá'],
    Forwards: ['Endrick','Gabriel Martinelli','Igor Thiago','Luiz Henrique','Matheus Cunha','Neymar','Raphinha','Rayan','Vinícius Júnior'],
  },
  Morocco: {
    Goalkeepers: ['Yassine Bounou','Munir El Kajoui','Reda Tagnaouti'],
    Defenders: ['Noussair Mazraoui','Anass Salah-Eddine','Youssef Belammari','Achraf Hakimi','Zakaria El Ouahdi','Chadi Riad','Nayef Aguerd','Redouane Halhal','Issa Diop'],
    Midfielders: ['Samir El Mourabet','Ayyoub Bouaddi','Neil El Aynaoui','Sofyan Amrabat','Azzedine Ounahi','Bilal El Khannouss','Ismael Saibari'],
    Forwards: ['Abde Ezzalzouli','Chemsdine Talbi','Soufiane Rahimi','Ayoub El Kaabi','Brahim Díaz','Gessime Yassine','Ayoube Amaimouni'],
  },
  Haiti: {
    Goalkeepers: ['Johny Placide','Alexandre Pierre','Josue Duverger'],
    Defenders: ['Carlens Arcus','Wilguens Paugain','Duke Lacroix','Martin Expérience','Jean-Kévin Duverne','Ricardo Adé','Hannes Delcroix','Keeto Thermoncy'],
    Midfielders: ['Carl Fred Sainté','Leverton Pierre','Danley Jean Jacques','Jean-Ricner Bellegarde','Woodensky Pierre','Dominique Simon'],
    Forwards: ['Don Deedson Louicius','Josué Casimir','Derrick Etienne','Ruben Providence','Duckens Nazon','Frantzdy Pierrot','Wilson Isidor','Yassin Fortuné','Lenny Joseph'],
  },
  Scotland: {
    Goalkeepers: ['Craig Gordon','Angus Gunn','Liam Kelly'],
    Defenders: ['Grant Hanley','Jack Hendry','Aaron Hickey','Dom Hyam','Scott McKenna','Nathan Patterson','Anthony Ralston','Andy Robertson','John Souttar','Kieran Tierney'],
    Midfielders: ['Ryan Christie','Finlay Curtis','Lewis Ferguson','Ben Gannon-Doak','Billy Gilmour','John McGinn','Kenny McLean','Scott McTominay'],
    Forwards: ['Ché Adams','Lyndon Dykes','George Hirst','Lawrence Shankland','Ross Stewart'],
  },
  'United States': {
    Goalkeepers: ['Chris Brady','Matt Freese','Matt Turner'],
    Defenders: ['Max Arfsten','Sergiño Dest','Alex Freeman','Mark McKenzie','Tim Ream','Chris Richards','Antonee Robinson','Miles Robinson','Joe Scally','Auston Trusty'],
    Midfielders: ['Tyler Adams','Sebastian Berhalter','Weston McKennie','Cristian Roldan','Brenden Aaronson','Malik Tillman','Tim Weah','Alejandro Zendejas'],
    Forwards: ['Christian Pulisic','Gio Reyna','Folarin Balogun','Ricardo Pepi','Haji Wright'],
  },
  // Final 26 — CNN Brasil (01/06/2026)
  Paraguay: {
    Goalkeepers: ['Gastón Olveira','Roberto Fernández','Orlando Gill'],
    Defenders: ['Juan Caceres','Júnior Alonso','Alexandro Maidana','Gustavo Gómez','Fabián Balbuena','Gustavo Velázquez','Omar Alderete','Jose Canale'],
    Midfielders: ['Andrés Cubas','Diego Gómez','Matías Galarza','Damián Bobadilla','Braian Ojeda','Mauricio Magalhaes'],
    Forwards: ['Julio Enciso','Kaku','Miguel Almirón','Gustavo Caballero','Ramón Sosa','Antonio Sanabria','Gabriel Avalos','Alex Arce','Isidro Pitta'],
  },
  Türkiye: {
    Goalkeepers: ['Ugurcan Cakir','Mert Gunok','Altay Bayindir','Muhammed Sengezer','Ersin Destanoglou'],
    Defenders: ['Merih Demiral','Zeki Celik','Caglar Soyuncu','Mert Muldur','Ferdi Kadioglu','Ozan Kabak','Abdulkerim Bardakci','Eren Elmali','Samet Akaydin','Mustafa Eskihellac','Yusuf Akcicek','Ahmetcan Kaplan'],
    Midfielders: ['Hakan Calhanoglou','Kaan Ayhan','Orkun Kokcu','Ismail Yuksek','Salih Ozcan','Atakan Karazor','Demir Ege Tiknaz'],
    Forwards: ['Kerem Akturkoglu','Irfan Can Kahveci','Baris Apler Yilmaz','Arda Guler','Kenan Yildiz','Yunus Akgun','Oguz Aydin','Deniz Gul','Yusuf Sari','Can Uzun','Aral Simsir'],
  },
  Germany: {
    Goalkeepers: ['Oliver Baumann','Manuel Neuer','Alexander Nübel'],
    Defenders: ['Waldemar Anton','Nathaniel Brown','David Raum','Antonio Rüdiger','Nico Schlotterbeck','Jonathan Tah','Malick Thiaw'],
    Midfielders: ['Pascal Gross','Joshua Kimmich','Felix Nmecha','Aleksandar Pavlovic','Angelo Stiller','Leon Goretzka','Florian Wirtz','Jamie Leweling','Nadiem Amiri'],
    Forwards: ['Maximilian Beier','Kai Havertz','Lennart Karl','Jamal Musiala','Leroy Sané','Deniz Undav','Nick Woltemade'],
  },
  Curacao: {
    Goalkeepers: ['Eloy Room','Tyrick Bodak','Trevor Doornbusch'],
    Defenders: ['Riechedly Bazoer','Joshua Brenet','Roshon van Eijma','Sherel Floranus','Deveron Fonville','Jurien Gaari','Armando Obispo','Shurandy Sambo'],
    Midfielders: ['Juninho Bacuna','Leandro Bacuna','Livano Comenencia','Kevin Felida',"Ar'jany Martha",'Tyrese Noslin','Godfried Roemeratoe'],
    Forwards: ['Jeremy Antonisse','Tahith Chong','Kenji Gorre','Sontje Hansen','Gervane Kastaneer','Brandley Kuwas','Jurgen Locadia','Jearl Margaritha'],
  },
  'Ivory Coast': {
    Goalkeepers: ['Yahia Fofana','Mohamed Koné','Alban Lafont'],
    Defenders: ['Emmanuel Agbadou','Clément Akpa','Ousmane Diomande','Guela Doué','Ghislain Konan','Odilon Kossounou','Evan Ndicka','Wilfried Singo'],
    Midfielders: ['Seko Fofana','Parfait Guiagon','Franck Kessié','Christ Inao Oulaï','Ibrahim Sangaré','Jean Michaël Seri'],
    Forwards: ['Simon Adingra','Ange-Yoan Bonny','Amad Diallo','Oumar Diakité','Yan Diomande','Evann Guessand','Nicolas Pépé','Bazoumana Touré','Elye Wahi'],
  },
  Netherlands: {
    Goalkeepers: ['Mark Flekken','Robin Roefs','Bart Verbruggen'],
    Defenders: ['Nathan Aké','Denzel Dumfries','Jorrel Hato','Jurriën Timber','Jan Paul van Hecke','Micky van de Ven','Virgil van Dijk'],
    Midfielders: ['Frenkie de Jong','Marten de Roon','Ryan Gravenberch','Teun Koopmeiners','Tijjani Reijnders','Guus Til','Quinten Timber','Mats Wieffer'],
    Forwards: ['Brian Brobbey','Memphis Depay','Cody Gakpo','Justin Kluivert','Noa Lang','Donyell Malen','Crysencio Summerville','Wout Weghorst'],
  },
  Japan: {
    Goalkeepers: ['Zion Suzuki','Keisuke Osako','Tomoki Hayakawa'],
    Defenders: ['Yūto Nagatomo','Shogo Taniguchi','Ko Itakura','Tsuyoshi Watanabe','Takehiro Tomiyasu','Hiroki Ito','Ayumu Seko','Yukinari Sugawara'],
    Midfielders: ['Junnosuke Suzuki','Wataru Endo','Junya Ito','Daichi Kamada','Ritsu Doan','Ao Tanaka','Keito Nakamura','Kaishu Sano','Takefusa Kubo','Yuito Suzuki'],
    Forwards: ['Koki Ogawa','Daizen Maeda','Ayase Ueda','Kento Shiogai','Keisuke Goto'],
  },
  Sweden: {
    Goalkeepers: ['Viktor Johansson','Kristoffer Nordfeldt','Jacob Widell Zetterstrom'],
    Defenders: ['Hjalmar Ekdal','Gabriel Gudmundsson','Isak Hien','Emil Holm','Gustaf Lagerbielke','Victor Lindelöf','Erik Smith','Carl Starfelt','Elliot Stroud','Daniel Svensson'],
    Midfielders: ['Taha Ali','Yasin Ayari','Lucas Bergvall','Jesper Karlström','Ken Sema','Mattias Svanberg','Besfort Zeneli'],
    Forwards: ['Alexander Bernhardsson','Anthony Elanga','Viktor Gyökeres','Alexander Isak','Gustaf Nilsson','Benjamin Nygren'],
  },
  Tunisia: {
    Goalkeepers: ['Aymen Dahmen','Sabri Ben Hessen','Abdelmouhib Chamakh'],
    Defenders: ['Montassar Talbi','Dylan Bronn','Omar Rekik','Yan Valery','Ali Abdi','Moutaz Neffati','Raed Chikhaoui','Adam Arous','Mohamed Amine Ben Hamida'],
    Midfielders: ['Ellyes Skhiri','Hannibal Mejbri','Anis Ben Slimane','Hadj Mahmoud','Rani Khedira','Mortadha Ben Ouanes'],
    Forwards: ['Elias Achouri','Ismaël Gharbi','Elias Saad','Sebastian Tounekti','Firas Chaouat','Khalil Ayari','Hazem Mastouri','Rayan Elloumi'],
  },
  Belgium: {
    Goalkeepers: ['Thibaut Courtois','Senne Lammens','Mike Penders'],
    Defenders: ['Timothy Castagne','Zeno Debast','Maxim De Cuyper','Koni De Winter','Brandon Mechele','Thomas Meunier','Nathan Ngoy','Joaquin Seys','Arthur Theate'],
    Midfielders: ['Kevin De Bruyne','Amadou Onana','Nicolas Raskin','Youri Tielemans','Hans Vanaken','Axel Witsel'],
    Forwards: ['Charles De Ketelaere','Jérémy Doku','Matias Fernandez-Pardo','Romelu Lukaku','Dodi Lukebakio','Diego Moreira','Alexis Saelemaekers','Leandro Trossard'],
  },
  // Final 26 — CNN Brasil (01/06/2026)
  Egypt: {
    Goalkeepers: ['Mohamed El Shenawy','Mostafa Shobeir','El Mahdi Soliman','Mohamed Alaa'],
    Defenders: ['Tarek Hamed','Hamdy Fathy','Rami Rabia','Yasser Ibrahim','Hossam Abdelmaguid','Mohamed Abdelmonemn','Ahmed Fatouh','Karim Hafez'],
    Midfielders: ['Marwan Ateya','Mohanad Lasheen','Nabil Emad','Mahmoud Saber','Ahmed Zizo','Emam Ashour','Mostafa Ziko','Mahmoud Trezeguet','Ibrahim Adel','Haissem Hassan'],
    Forwards: ['Omar Marmoush','Mohamed Salah','Akram Tawfiq','Hamza Abdelkarim'],
  },
  // Final 26 — CNN Brasil (01/06/2026)
  Iran: {
    Goalkeepers: ['Alireza Beiranvand','Hossein Hosseini','Payam Niazmand'],
    Defenders: ['Danial Eiri','Ehsan Hajsafi','Saleh Hardani','Hossein Kanaani','Shoka Khalilzadeh','Milad Mohammadi','Ali Nemati','Ramin Rezaeian'],
    Midfielders: ['Rouzbeh Cheshmi','Saeid Ezatolahi','Mehdi Ghaedi','Saman Ghoddos','Mohammad Ghorbani','Alireza Jahanbakhsh','Mohammad Mohebi','Amir Mohammad Razzaghinia','Mehdi Torabi','Aria Yousefi'],
    Forwards: ['Ali Alipour','Dennis Dargahi','Amirhossein Hosseinzadeh','Mehdi Taremi','Shahriar Moghanlou'],
  },
  'New Zealand': {
    Goalkeepers: ['Max Crocombe','Alex Paulsen','Michael Woud'],
    Defenders: ['Tim Payne','Francis De Vries','Tyler Bindon','Michael Boxall','Liberato Cacace','Nando Pijnaker','Finn Surman','Callan Elliot','Tommy Smith'],
    Midfielders: ['Joe Bell','Matt Garbett','Marko Stamenic','Sarpreet Singh','Alex Rufer','Ryan Thomas'],
    Forwards: ['Chris Wood','Eli Just','Kosta Barbarouses','Ben Waine','Ben Old','Callum McCowatt','Jesse Randall','Lachlan Bayliss'],
  },
  Spain: {
    Goalkeepers: ['Unai Simón','David Raya','Joan García'],
    Defenders: ['Marc Cucurella','Pau Cubarsí','Aymeric Laporte','Álex Grimaldo','Pedro Porro','Eric García','Marcos Llorente','Marc Pubill'],
    Midfielders: ['Gavi','Rodri','Pedri','Martín Zubimendi','Fabián Ruiz','Álex Baena','Mikel Merino'],
    Forwards: ['Lamine Yamal','Nico Williams','Dani Olmo','Ferran Torres','Mikel Oyarzabal','Yéremy Pino','Borja Iglesias','Víctor Muñoz'],
  },
  'Cape Verde': {
    Goalkeepers: ['Vozinha','Marcio Rosa','CJ dos Santos'],
    Defenders: ['Steven Moreira','Wagner Pina','Joao Paulo','Sidny Lopes Cabral','Logan Costa','Pico','Kelvin Pires','Stopira','Diney'],
    Midfielders: ['Jamiro Monteiro','Telmo Arcanjo','Yannick Semedo','Laros Duarte','Deroy Duarte','Kevin Pina'],
    Forwards: ['Ryan Mendes','Willy Semedo','Garry Rodrigues','Jovane Cabral','Nuno da Costa','Dailon Livramento','Gilson Benchimol','Helio Varela'],
  },
  France: {
    Goalkeepers: ['Mike Maignan','Robin Risser','Brice Samba'],
    Defenders: ['Lucas Digne','Malo Gusto','Lucas Hernández','Theo Hernández','Ibrahima Konaté','Jules Koundé','Maxence Lacroix','William Saliba','Dayot Upamecano'],
    Midfielders: ["N'Golo Kanté",'Manu Koné','Adrien Rabiot','Aurélien Tchouaméni','Warren Zaïre-Emery'],
    Forwards: ['Maghnes Akliouche','Bradley Barcola','Rayan Cherki','Ousmane Dembélé','Désiré Doué','Jean-Philippe Mateta','Kylian Mbappé','Michael Olise','Marcus Thuram'],
  },
  Senegal: {
    Goalkeepers: ['Édouard Mendy','Mory Diaw','Yehvann Diouf'],
    Defenders: ['Krépin Diatta','Antoine Mendy','Kalidou Koulibaly','El Hadji Malick Diouf','Mamadou Sarr','Moussa Niakhaté','Moustapha Mbow','Abdoulaye Seck','Ismail Jakobs','Ilay Camara'],
    Midfielders: ['Idrissa Gana Gueye','Pape Gueye','Lamine Camara','Habib Diarra','Pathé Ciss','Pape Matar Sarr','Bara Sapoko Ndiaye'],
    Forwards: ['Sadio Mané','Ismaïla Sarr','Iliman Ndiaye','Assane Diao','Ibrahim Mbaye','Nicolas Jackson','Bamba Dieng','Cherif Ndiaye'],
  },
  Norway: {
    Goalkeepers: ['Ørjan Nyland','Egil Selvik','Sander Tangvik'],
    Defenders: ['Julian Ryerson','Kristoffer Ajer','Leo Østigård','David Møller Wolfe','Marcus Pedersen','Torbjørn Heggem','Fredrik André Bjørkan','Henrik Falchener','Sondre Langås'],
    Midfielders: ['Martin Ødegaard','Sander Berge','Patrick Berg','Kristian Thorstvedt','Morten Thorsby','Thelo Aasgaard','Andreas Schjelderup','Jens Petter Hauge','Fredrik Aursnes','Oscar Bobb','Antonio Nusa'],
    Forwards: ['Erling Haaland','Alexander Sørloth','Jørgen Strand Larsen'],
  },
  // Final 26-man roster announced May 28, 2026 (Mastantuono & Acuña cut)
  Argentina: {
    Goalkeepers: ['Emiliano Martínez','Gerónimo Rulli','Juan Musso'],
    Defenders: ['Nahuel Molina','Nicolás Tagliafico','Gonzalo Montiel','Lisandro Martínez','Cristian Romero','Nicolás Otamendi','Leonardo Balerdi','Facundo Medina'],
    Midfielders: ['Rodrigo De Paul','Leandro Paredes','Giovani Lo Celso','Alexis Mac Allister','Enzo Fernández','Exequiel Palacios','Valentín Barco'],
    Forwards: ['Lionel Messi','Lautaro Martínez','Julián Álvarez','Nicolás González','Thiago Almada','Giuliano Simeone','Nicolas Paz','Jose Manuel Lopez'],
  },
  Austria: {
    Goalkeepers: ['Alexander Schlager','Florian Wiegele','Patrick Pentz'],
    Defenders: ['David Affengruber','Kevin Danso','Stefan Posch','David Alaba','Philipp Lienhart','Philipp Mwene','Alexander Prass','Marco Friedl','Michael Svoboda'],
    Midfielders: ['Xaver Schlager','Nicolas Seiwald','Marcel Sabitzer','Florian Grillitsch','Carney Chukwuemeka','Romano Schmid','Christoph Baumgartner','Konrad Laimer','Patrick Wimmer','Paul Wanner','Alessandro Schopf'],
    Forwards: ['Marko Arnautovic','Michael Gregoritsch','Sasa Kalajdzic'],
  },
  Jordan: {
    Goalkeepers: ['Yazid Abulaila','Abdallah Al-Fakhouri','Ahmad Al-Juiadi','Nour Bani Attiah'],
    Defenders: ['Mohammad Abualnadi','Yousef Abu Al-Jazar','Husam Abu Dahab','Mohammed Abu Hashish','Mohannad Abu Taha','Yazan Al-Arab','Saed Al-Rosna','Ahmad Assaf','Anas Badawi','Abdallah Nasib','Ehsan Haddad','Saleem Obaid','Mohammad Abu Taha'],
    Midfielders: ['Mohammed Al-Dawoud','Nizar Al-Rashdan','Noor Al-Rawabdeh','Rajaei Ayed','Amer Jamous','Yousef Qashi','Ibrahim Sadeh'],
    Forwards: ['Mohammed Abu Zraiq','Mousa Al-Tamari','Ali Azaizeh','Odeh Al-Fakhouri','Ali Olwan','Ibrahim Sabra'],
  },
  Portugal: {
    Goalkeepers: ['Diogo Costa','José Sá','Rui Silva','Ricardo Velho'],
    Defenders: ['Rúben Dias','João Cancelo','Diogo Dalot','Nuno Mendes','Nélson Semedo','Matheus Nunes','Gonçalo Inacio','Renato Veiga','Tomás Araújo'],
    Midfielders: ['Bruno Fernandes','Bernardo Silva','Vitinha','João Neves','Rúben Neves','Samú Costa'],
    Forwards: ['Cristiano Ronaldo','Rafael Leão','João Félix','Gonçalo Ramos','Pedro Neto','Francisco Conceição','Gonçalo Guedes','Francisco Trincão'],
  },
  // Final 26-man roster announced May 26, 2026
  Panama: {
    Goalkeepers: ['Orlando Mosquera','Luis Mejía','César Samudio'],
    Defenders: ['César Blackman','Jorge Gutiérrez','Amir Murillo','Fidel Escobar','Andrés Andrade','Edgardo Fariña','José Córdoba','Éric Davis','Jiovany Ramos','Roderick Miller'],
    Midfielders: ['Aníbal Godoy','Carlos Harvey','Cristian Martinez','José Rodríguez','César Yanis','Yoel Bárcenas','Azarías Londoño','Adalberto Carrasquilla','Alberto Quintero'],
    Forwards: ['Ismael Díaz','Cecilio Waterman','José Fajardo','Tomás Rodríguez'],
  },
  'Congo DR': {
    Goalkeepers: ['Lionel Mpasi','Timothy Fayulu','Matthieu Epolo'],
    Defenders: ['Chancel Mbemba','Axel Tuanzebe','Arthur Masuaku','Gedeon Kalulu','Joris Kayembe','Aaron Wan-Bissaka','Aaron Tshibola','Steve Kapuadi','Dylan Batubinsika'],
    Midfielders: ['Noah Sadiki','Charles Pickel','Edo Kayembe','Samuel Moutoussamy',"Ngal'ayel Mukau",'Nathanaël Mbuku','Meschak Elia','Brian Cipenga','Gaël Kakuta','Théo Bongonda'],
    Forwards: ['Simon Banza','Yoane Wissa','Fiston Mayele','Cédric Bakambu'],
  },
  // ===== Rosters finais 26 adicionados via CNN Brasil (01/06/2026) =====
  // Antes ficavam com a lista preliminar crua da API (>26).
  'Saudi Arabia': {
    Goalkeepers: ['Ahmed Al Kassar','Mohammed Al Owais','Nawaf Al Aqidi'],
    Defenders: ['Saud Abdulhamid','Mohammed Abu Al Shamat','Khalid Al Ghannam','Moteb Al Harbi','Abdulelah Al Amri','Nawaf Boushal','Hassan Kadesh','Ali Lajami','Ali Majrashi','Hassan Tambakti','Jehad Thikri'],
    Midfielders: ['Nasser Al Dawsari','Alaa Al Hajji','Ziyad Al Johani','Musab Al Juwayr','Abdullah Al Khaibari','Mohammed Kanno','Sultan Mandash','Ayman Yahya'],
    Forwards: ['Feras Al Brikan','Salem Al Dawsari','Abdullah Al Hamdan','Saleh Al Shehri'],
  },
  Canada: {
    Goalkeepers: ['Dayne St. Clair','Maxim Crépeau','Owen Goodman'],
    Defenders: ['Alistair Johnston','Derek Cornelius','Richie Laryea','Niko Sigur','Joel Waterman','Luc De Fougerolles','Moise Bombito','Alfie Jones','Alphonso Davies'],
    Midfielders: ['Stephen Eustáquio','Ismael Koné','Tajon Buchanan','Mathieu Choinière','Ali Ahmed','Nathan Saliba','Liam Millar','Marcelo Flores','Jacob Shaffelburg','Jonathan Osorio'],
    Forwards: ['Jonathan David','Cyle Larin','Tani Oluwaseyi','Promise David'],
  },
  Ecuador: {
    Goalkeepers: ['Hernán Galíndez','Moisés Ramírez','Gonzalo Valle'],
    Defenders: ['Piero Hincapié','Willian Pacho','Pervis Estupiñán','Félix Torres','Joel Ordoñez','Jackson Porozo','Angelo Preciado'],
    Midfielders: ['Moisés Caicedo','Alan Franco','Kendry Páez','Pedro Vite','Jordy Alcívar','Denil Castillo','Yaimar Medina'],
    Forwards: ['Enner Valencia','Gonzalo Plata','Alan Minda','John Yeboah','Kevin Rodríguez','Jordy Caicedo','Nilson Angulo','Anthony Valencia','Jeremy Arévalo'],
  },
  Algeria: {
    Goalkeepers: ['Oussama Benbot','Melvin Mastil','Luca Zidane'],
    Defenders: ['Achraf Abada','Rayan Aït-Nouri','Zinedine Belaïd','Rafik Belghali','Ramy Bensebaïni','Samir Chergui','Jaouen Hadjam','Aïssa Mandi','Mohamed Tougai'],
    Midfielders: ['Houssem Aouar','Nabil Bentaleb','Hicham Boudaoui','Farès Chaïbi','Ibrahim Maza','Yassine Titraoui','Ramiz Zerrouki'],
    Forwards: ['Mohamed Amoura','Nadir Benbouali','Adil Boulbina','Farès Ghedjemis','Amine Gouiri','Riyad Mahrez','Anis Hadj-Moussa'],
  },
  Uruguay: {
    Goalkeepers: ['Sergio Rochet','Fernando Muslera','Santiago Mele'],
    Defenders: ['Guillermo Varela','Ronald Araújo','José Giménez','Santiago Bueno','Sebastián Cáceres','Mathías Olivera','Joaquín Piquerez','Matías Viña'],
    Midfielders: ['Juan Sanabria','Manuel Ugarte','Emiliano Martínez','Rodrigo Bentancur','Federico Valverde','Giorgian de Arrascaeta','Nicolás de la Cruz','Rodrigo Zalazar','Agustín Canobbio','Facundo Pellistri','Maxi Araújo','Brian Rodríguez'],
    Forwards: ['Rodrigo Aguirre','Federico Viñas','Darwin Núñez'],
  },
  Colombia: {
    Goalkeepers: ['Camilo Vargas','Álvaro Montero','David Ospina'],
    Defenders: ['Davinson Sánchez','Jhon Lucumí','Yerry Mina','Daniel Muñoz','Willer Ditta','Santiago Arias','Johan Mojica','Deiver Machado'],
    Midfielders: ['Richard Ríos','Jefferson Lerma','Kevin Castaño','Gustavo Puerta','Jhon Arias','Jorge Carrascal','Juan Portilla','Juan Quintero','James Rodríguez','Jaminton Campaz'],
    Forwards: ['Cucho Hernández','Luis Díaz','Luis Suárez','Andrés Gómez','Jhon Córdoba'],
  },
};

const squads = JSON.parse(readFileSync(SQUADS_PATH, 'utf8'));

let totalTeams = 0, totalPlayers = 0;
for (const [espnTeam, byPos] of Object.entries(ESPN)) {
  const dbTeam = TEAM_MAP[espnTeam] ?? espnTeam;
  if (!squads[dbTeam]) {
    console.warn(`! Time ${dbTeam} não existe em squads.json — pulando`);
    continue;
  }
  const existingByName = new Map((squads[dbTeam].players || []).map(p => [p.name, p]));

  const players = [];
  for (const [espnPos, names] of Object.entries(byPos)) {
    const pos = POS_MAP[espnPos];
    for (const fullName of names) {
      const initialName = toInitial(fullName);
      const ex = existingByName.get(initialName) || existingByName.get(fullName);
      if (ex) {
        players.push({ ...ex, name: initialName, position: pos });
      } else {
        players.push({ name: initialName, position: pos, number: null });
      }
    }
  }
  squads[dbTeam].players = players;
  totalTeams++;
  totalPlayers += players.length;
}

writeFileSync(SQUADS_PATH, JSON.stringify(squads, null, 2));
console.log(`\n✓ ${totalTeams} seleções atualizadas com rosters finais ESPN (${totalPlayers} players)`);
