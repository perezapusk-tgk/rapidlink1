/* Torclix Backups — определение класса ТС по марке/модели. Общий файл для index.html и admin.html.
   Классы (по порядку в каталоге мойки): 0 мото, 1 квадро/снегоход, 2 легковой, 3 кроссовер, 4 внедорожник/пикап, 5 минивэн/фургон, 6 прицеп.
   Формат записи: [алиасы марки через |, класс по умолчанию (-1: неоднозначно), 'класс:модели;класс:модели'] */
(function (root) {
  'use strict';
  var DB = [
    /* ---- Россия ---- */
    ['lada|лада|ваз|vaz|жигули', -1, '2:granta|гранта|vesta|веста|kalina|калина|priora|приора|samara|самара|2101|2102|2103|2104|2105|2106|2107|2108|2109|21099|2110|2111|2112|2113|2114|2115|aura|аура|oka|ока;3:xray|иксрей|vestacross|вестакросс|vestaswcross|grantacross|грантакросс|kalinacross|калинакросс;4:niva|нива|4x4|2121|2131|urban|урбан|travel|тревел|legend|легенд;5:largus|ларгус|2120|надежда'],
    ['uaz|уаз', 4, '4:patriot|патриот|hunter|хантер|pickup|пикап|profi|профи|3151|469|simbir|симбир;5:буханка|450|452|3741|3962|3909|cargo|карго'],
    ['gaz|газ|газель', 5, '5:gazel|газель|next|некст|sobol|соболь|valdai|валдай|3302|2705|3221|gazon|газон|sadko|садко;2:volga|волга|3110|31105|3102|siber|сайбер'],
    ['moskvich|москвич', -1, '3:moskvich3|москвич3;2:moskvich6|москвич6'],
    ['aurus|аурус', 2, '2:senat|сенат;4:komendant|комендант;5:arsenal|арсенал'],
    /* ---- Китай ---- */
    ['haval|хавал|хавейл', 3, '3:jolion|джолион|f7|f7x|h6|h2|h4|dargo|дарго|m6;4:h9|h5'],
    ['chery|чери|черри', 3, '2:arrizo|аризо|amulet|амулет|fora|фора|bonus|бонус|very|kimo|indis|m11|a13|eastar;3:tiggo|тигго'],
    ['exeed|эксид', 3, '3:lx|txl|vx|rx'],
    ['omoda|омода', 3, '3:c5|c9|s5'],
    ['jaecoo|джейку|jaeku', 3, '3:j7|j8'],
    ['tenet|тенет', 3, '3:t4|t7|t8'],
    ['jetour|джетур', 3, '3:x70|x90|dashing|дашинг;4:t2|т2'],
    ['geely|джили|гили', -1, '2:emgrand|эмгранд|preface|префейс|vision|визион|otaka|отака;3:coolray|кулрей|atlas|атлас|tugella|тугелла|okavango|azkarra|азкарра|geometry|starray|старрей;4:monjaro|монджаро|boyue|боюэ|xingyue'],
    ['changan|чанган|чанъан', 3, '2:alsvin|алсвин|eado|эадо;3:cs35|cs55|cs75|unik|unit|uni-k|uni-t;4:cs95|hunter|хантер'],
    ['byd|бид', 3, '2:seal|сиэл|qin|dolphin|долфин|seagull|f3|e2;3:song|yuan|юань|atto3|атто3|tang|танг|destroyer'],
    ['great wall|greatwall|грейт волл|грейтволл|gwm|гвм', 3, '4:poer|пауэр|wingle|вингл|steed|стид|cannon|кэннон;3:hover|ховер|h3|coolbear'],
    ['tank|танк', 4, '4:300|400|500|700|800'],
    ['lifan|лифан', -1, '2:solano|солано|breez|бриз|cebrium|себриум|celliya|селия|smily|смайли|320|520|620;3:x60|x70|x50|myway|мувей;5:foison|фойсон'],
    ['jac|джак', -1, '2:j3|j5|j4;3:s2|s3|s5|s7|js4|js6;4:t6|t8|t9|t40;5:sunray|санрей'],
    ['faw|фав', -1, '2:besturn|бестурн|b50|b70|b30|oley|олей;3:x40|x80|t77|t55|t33|t99;5:v80|v5|vita|вита'],
    ['dongfeng|донгфенг|донфенг|dfm|дфм', -1, '2:s30|h30;3:ax4|ax5|ax7|aeolus|аэолус|580|fengon|фенгон|glory;5:c35|c37|k07'],
    ['kaiyi|кайи', 3, '3:x3|x7|e5'],
    ['belgee|белджи', 3, '2:s50;3:x50|x70'],
    ['voyah|воях', 3, '3:free|mind;5:dreamer|дример'],
    ['zeekr|зикр', 3, '2:001|007;3:x'],
    ['hongqi|хонгци|хунцы', -1, '2:h5|h9|h7|eh7|eh9;3:hs3|hs5;4:hs7|hs9|ehs9'],
    ['lixiang|li auto|лисян', 4, '3:l6;4:l7|l8|l9;5:mega|мега'],
    ['zotye|зоти', 3, '3:t600|t300|t700|coupa'],
    ['livan|ливан', 3, '3:x3|x6|s6'],
    /* ---- Корея ---- */
    ['kia|киа', -1, '2:rio|рио|cerato|серато|k3|k5|k7|k900|optima|оптима|ceed|сид|proceed|stinger|стингер|picanto|пиканто|soul|соул|forte|форте|cadenza;3:sportage|спортейдж|seltos|селтос|sonet|niro|ниро|stonic|стоник|xceed|ev6|carens|каренс;4:sorento|соренто|mohave|мохаве|telluride|теллурайд|borrego|ev9;5:carnival|карнавал|sedona|седона|bongo|бонго'],
    ['hyundai|хендай|хендэ|хёндэ|хундай|хюндай|хундэ|хендей', -1, '2:solaris|солярис|accent|акцент|elantra|элантра|sonata|соната|i30|i20|i40|i10|veloster|велостер|genesis|генезис|grandeur|грандер|azera|equus|getz|гетц|avante|verna|ioniq|айоник;3:creta|крета|tucson|туссан|туксон|kona|кона|bayon|venue|ix35|nexo;4:santafe|сантафе|palisade|палисад|terracan|террокан|galloper|галлопер|veracruz|верракруз|ix55;5:starex|старекс|h1|h100|h350|staria|стариа|porter|портер|solati'],
    ['genesis|дженезис|дженесис', -1, '2:g70|g80|g90;3:gv60|gv70;4:gv80'],
    ['ssangyong|ссангйонг|санйонг|сангенг|санг йонг', -1, '3:actyon|актион|korando|корандо|tivoli|тиволи|kyron|кайрон;4:rexton|рекстон|musso|муссо|grandmusso;5:rodius|родиус|stavic|ставик'],
    ['daewoo|дэу|деу', 2, '2:nexia|нексия|matiz|матиз|lanos|ланос|nubira|нубира|espero|эсперо|gentra|джентра|leganza|леганза|tico|тико;5:damas|дамас|labo|лабо'],
    /* ---- Япония ---- */
    ['toyota|тойота|тоёта', -1, '2:camry|камри|corolla|королла|avensis|авенсис|yaris|ярис|prius|приус|auris|аурис|crown|краун|mark2|markx|allion|аллион|premio|премио|vitz|витц|aqua|аква|passo|пассо|vios|виос|celica|supra|супра|gr86|mirai|sai|chaser|чайзер|cresta|креста|altezza|windom;3:rav4|рав4|chr|corollacross|harrier|харриер|venza|венза|yariscross|rush|раш|urbancruiser|raize|kluger|клюгер|highlander|хайлендер;4:landcruiser|лэндкрузер|ландкрузер|крузер|prado|прадо|fortuner|фортунер|hilux|хайлюкс|хайлакс|sequoia|секвойя|tundra|тундра|tacoma|такома|4runner|lc200|lc300|lc79|lc76|lc150|hilander;5:alphard|альфард|vellfire|веллфайр|hiace|хайс|хайэйс|sienna|сиена|previa|превия|estima|эстима|noah|ноах|voxy|вокси|granvia|гранвия|townace|таунэйс|proace|проэйс|wish|виш|sienta|сиента|ipsum|ипсум|verso|версо'],
    ['lexus|лексус', -1, '2:is|es|gs|ls|ct|rc|lc|is250|is300|es250|es300|es350|gs250|gs300|gs350|ls460|ls500;3:nx|ux|rx|rx200|rx300|rx350|rx450|nx200|nx300|ux200|ux250;4:gx|lx|gx460|gx470|lx470|lx570|lx600|lx450|rx500'],
    ['nissan|ниссан', -1, '2:almera|альмера|tiida|тиида|sentra|сентра|teana|теана|maxima|максима|primera|примера|note|ноут|micra|микра|leaf|лиф|sunny|санни|skyline|скайлайн|gtr|370z|350z|silvia|cefiro|цефиро|laurel|fuga|фуга|cima|pulsar|latio|versa|wingroad|sylphy|силфи;3:qashqai|кашкай|xtrail|хтрейл|икстрейл|juke|жук|kicks|murano|мурано|rogue|ariya|dualis;4:patrol|патрол|pathfinder|патфайндер|terrano|террано|navara|навара|frontier|фронтир|armada|армада|xterra|safari|сафари|titan|титан;5:serena|селена|elgrand|эльгранд|primastar|nv200|caravan|караван|urvan|урван|vanette|ваннет'],
    ['infiniti|инфинити', -1, '2:g35|g37|q50|q60|m35|m37|m45|q70|ex35|ex37;3:qx50|qx30|qx55|fx35|fx37|fx50|jx35;4:qx56|qx60|qx70|qx80|fx45|fx50s'],
    ['mazda|мазда', -1, '2:mazda3|мазда3|mazda6|мазда6|axela|аксела|atenza|атенца|demio|демио|familia|фамилия|rx8|rx7|mx5|мх5|mazda2;3:cx3|cx30|cx5|сх5|cx50|cx7|cx8|cx9|cx60|cx80|cx90|mx30;4:bt50|b2500;5:premacy|премаси|biante|бианте|bongo|бонго|mpv|tribute'],
    ['mitsubishi|митсубиси|мицубиси|митсубиши', -1, '2:lancer|лансер|galant|галант|carisma|карисма|colt|кольт|mirage|мираж|eclipse|эклипс|evolution|3000gt|gto;3:asx|асх|outlander|аутлендер|аутлэндер|eclipsecross|rvr;4:pajero|паджеро|montero|монтеро|l200|л200|triton|тритон|pajerosport|challenger;5:delica|делика|grandis|грандис|spacewagon|chariot|шариот|xpander|экспандер|l300|л300'],
    ['subaru|субару', -1, '2:impreza|импреза|legacy|легаси|levorg|леворг|wrx|brz|justy|liberty;3:xv|crosstrek|forester|форестер|outback|аутбек|аутбэк|tribeca|трибека|ascent|асент|solterra;5:exiga|domingo|sambar|самбар'],
    ['suzuki|сузуки', -1, '2:swift|свифт|baleno|балено|liana|лиана|alto|альто|wagonr|splash|kizashi|кизаши|celerio;3:sx4|сх4|vitara|витара|scross|ignis|игнис|xl7|fronx;4:grandvitara|jimny|джимни|escudo|эскудо|samurai|самурай|sidekick;5:ertiga|эртига|apv|carry|everyv|solio;0:gsxr|gsx|vstrom|hayabusa|хаябуса|bandit|бандит|burgman|бургман|djebel|drz|rmz|katana|катана;1:kingquad|кингквад|lta|ltz|ltr|ltf'],
    ['honda|хонда', -1, '2:civic|цивик|accord|аккорд|fit|фит|jazz|джаз|insight|инсайт|integra|интегра|legend|s2000|city|сити|airwave|torneo|inspire|shuttle|шаттл|domani|partner|mobilio;3:crv|срв|hrv|врв|vezel|везел|xrv|zrv|elysion;4:pilot|пилот|ridgeline|риджлайн|passport|паспорт|crossroad;5:stepwgn|степвагон|stream|стрим|freed|фрид|odyssey|одиссей|nvan|acty;0:cbr|crf|cmx|rebel|ребел|africatwin|goldwing|голдвинг|nc750|transalp|vfr|vtx|hornet|хорнет|pcx|forza|форза|silverwing|zoomer|monkey|dio|дио;1:trx|foreman|форман|rancher|ранчер|rubicon|pioneer|пионер|talon|fourtrax|recon|sportrax'],
    ['acura|акура', -1, '2:tlx|tl|ilx|rlx|tsx;3:rdx|zdx|mdx'],
    /* ---- Америка ---- */
    ['ford|форд', -1, '2:focus|фокус|mondeo|мондео|fiesta|фиеста|fusion|фьюжн|taurus|таурус|mustang|мустанг|escort|эскорт|sierra|сиерра|scorpio|скорпио|ka|ка|cmax;3:kuga|куга|ecosport|экоспорт|escape|эскейп|puma|пума|edge|эдж;4:explorer|эксплорер|expedition|экспедишн|f150|f250|f350|ranger|рейнджер|bronco|бронко|everest|эверест;5:transit|транзит|tourneo|торнео|galaxy|галакси|econoline'],
    ['chevrolet|шевроле|шевролет', -1, '2:cruze|круз|aveo|авео|lacetti|лачетти|cobalt|кобальт|spark|спарк|malibu|малибу|camaro|камаро|epica|эпика|lanos|ланос|corvette|корвет|impala|импала;3:captiva|каптива|trax|трэкс|equinox|эквинокс|orlando|орландо|tracker;4:niva|нива|tahoe|тахо|suburban|субурбан|trailblazer|трейлблейзер|silverado|сильверадо|blazer|блейзер|colorado|колорадо|avalanche;5:express|экспресс|rezzo|рэззо|uplander'],
    ['jeep|джип', 4, '3:renegade|ренегат|compass|компас|cherokee|чероки|patriot;4:wrangler|вранглер|grandcherokee|гранд чероки|commander|gladiator|гладиатор|wagoneer'],
    ['dodge|додж', -1, '2:charger|чарджер|challenger|челленджер|avenger|neon|stratus|caliber;3:journey|джорни|nitro;4:durango|дуранго|ram|рэм|dakota;5:caravan|караван|grandcaravan'],
    ['chrysler|крайслер', -1, '2:300c|sebring|себринг|neon|pt cruiser|ptcruiser;5:voyager|вояджер|town country|towncountry|pacifica|пасифика'],
    ['cadillac|кадиллак', -1, '2:cts|ats|ct5|ct6|sts|seville|xts|deville;3:xt4|xt5|srx;4:escalade|эскалейд|xt6'],
    ['tesla|тесла', -1, '2:model3|models|model s;3:modely|model y;4:modelx|model x|cybertruck|кибертрак'],
    ['lincoln|линкольн', -1, '2:continental|towncar;4:navigator|навигатор|aviator|нaутилус|nautilus'],
    ['gmc|джиэмси', 4, '4:yukon|юкон|sierra|терраин|terrain|acadia|акадия|canyon;5:savana|savanna'],
    ['buick|бьюик', 3, '3:encore|envision|enclave'],
    /* ---- Европа ---- */
    ['opel|опель', -1, '2:astra|астра|vectra|вектра|insignia|инсигния|corsa|корса|omega|омега|tigra|kadett|каддет|ascona|асконa|adam;3:mokka|мокка|crossland|grandland|antara|антара;4:frontera|фронтера;5:zafira|зафира|combo|комбо|vivaro|виваро|movano|мовано|meriva|мерива'],
    ['renault|рено', -1, '2:logan|логан|sandero|сандеро|megane|меган|fluence|флюенс|clio|клио|symbol|символ|laguna|лагуна|latitude|talisman|талисман|safrane|twingo|zoe;3:duster|дастер|kaptur|каптур|arkana|аркана|captur|kadjar|каджар|koleos|колеос|austral|kwid;4:oroch|орок|alaskan|niagara;5:kangoo|кангу|trafic|трафик|master|мастер|scenic|сценик|espace|эспейс|lodgy|лоджи|dokker|доккер'],
    ['peugeot|пежо', -1, '2:206|207|208|301|307|308|406|407|408|508|107|108|307;3:2008|3008|5008;5:partner|партнер|expert|эксперт|boxer|боксер|rifter|traveller'],
    ['citroen|ситроен', -1, '2:c3|c4|c5|c elysee|celysee|c-elysee|c1|c2|xsara|ксара|saxo|;3:c3aircross|c4aircross|c5aircross|c4cactus|cactus;5:berlingo|берлинго|jumpy|джампи|jumper|джампер|spacetourer|c8|c4picasso|picasso|пикассо'],
    ['skoda|шкода', -1, '2:octavia|октавия|rapid|рапид|superb|суперб|fabia|фабия|scala|скала|citigo|ситиго|felicia|фелиция;3:kodiaq|kodiak|кодиак|karoq|карок|kamiq|камик|yeti|йети|enyaq;5:roomster|румстер'],
    ['volkswagen|фольксваген|vw|фолькс|фольц|вольц', -1, '2:polo|поло|jetta|джетта|passat|пассат|golf|гольф|arteon|артеон|bora|бора|scirocco|beetle|lupo|лупо|fox|phaeton|фаэтон|vento|derby|corrado|id3|id7;3:tiguan|тигуан|taos|taigo|tcross|troc|nivus|id4|id5;4:touareg|туарег|amarok|амарок|atlas|атлас|teramont|терамонт|tayron;5:touran|туран|sharan|шаран|caddy|кадди|multivan|мультиван|transporter|транспортер|caravelle|каравелла|crafter|крафтер|t4|t5|t6|t7'],
    ['audi|ауди', -1, '2:a1|a3|a4|a5|a6|a7|a8|s3|s4|s5|s6|s7|s8|rs3|rs4|rs5|rs6|rs7|r8|allroad|a4allroad|100|80|90|200|etrongt;3:q2|q3|q4|q5|sq2|sq3|sq5;4:q7|q8|sq7|sq8|rsq8'],
    ['bmw|бмв|бумер|бэха', -1, '2:1series|2series|3series|4series|5series|6series|7series|8series|116|118|120|316|318|320|325|328|330|335|520|523|525|528|530|535|540|730|735|740|750|760|m2|m3|m4|m5|e30|e34|e36|e39|e46|e60|e90|f10|f30|g20|g30|g60|z4|i3|i4|i7|grancoupe;3:x1|x2|x3|x4|ix3;4:x5|x6|x7|xm|ix;0:r1250gs|r1200gs|r1250|r1200|gs|s1000rr|s1000|f850gs|f750gs|f900|k1600'],
    ['mercedes|мерседес|мерс|benz|бенц', -1, '2:aclass|аклас|a180|a200|bclass|cclass|c180|c200|c250|c300|c63|eclass|e200|e220|e250|e300|e350|e63|sclass|s400|s500|s560|s600|s63|cla|cls|клс|amggt|slk|slc|w124|w140|w202|w203|w204|w205|w210|w211|w212|w213|w220|w221|w222|w223|maybach|майбах;3:gla|гла|glb|глб|glc|глц|glk|глк|gle|глэ|eqa|eqb|eqc|eqe;4:gclass|гелик|гелендваген|гелендж|g500|g63|g55|gls|глс|mclass|ml350|ml500|xclass|x250|x350|glclass|gl450|gl500;5:vclass|v250|vito|вито|viano|виано|sprinter|спринтер|marcopolo|citan|ситан|valente|vaneo'],
    ['porsche|порше', -1, '2:911|718|panamera|панамера|taycan|тайкан|boxster|бокстер|cayman|кайман;3:macan|макан;4:cayenne|кайен|кайенн'],
    ['volvo|вольво', -1, '2:s40|s60|s80|s90|v40|v50|v60|v70|v90|c30|c70|850|s70;3:xc40|xc60|c40;4:xc90|xc70|v90cc;5:'],
    ['land rover|landrover|ленд ровер|лэнд ровер|ландровер|range rover|рендж ровер|рейндж ровер|рэнж ровер', 4, '3:evoque|эвок|discoverysport|freelander|фрилендер|velar|веляр;4:discovery|дискавери|defender|дефендер|'],
    ['mini|мини|миникупер', 2, '2:cooper|купер|one|hatch;3:countryman|кантримен|clubman|paceman'],
    ['fiat|фиат', -1, '2:punto|пунто|bravo|браво|linea|линеа|albea|альбеа|tipo|типо|500|panda|панда;3:500x|500l|freemont;5:doblo|добло|ducato|дукато|scudo|скудо|fiorino|фиорино'],
    ['seat|сеат|сиат', 2, '2:leon|леон|ibiza|ибица|toledo|толедо|cordoba;3:ateca|атека|arona|арона;5:alhambra|альгамбра'],
    ['jaguar|ягуар', -1, '2:xf|xe|xj|xk|ftype|ftype|s-type|stype|xtype;3:epace|fpace|ipace'],
    ['alfa romeo|alfaromeo|альфа ромео', -1, '2:giulia|джулия|156|159|147|giulietta|мито|mito;3:stelvio|стельвио|tonale'],
    ['bentley|бентли|rolls royce|rollsroyce|роллс ройс|maserati|мазерати|ferrari|феррари|lamborghini|ламборгини|aston martin|астон мартин', -1, '2:continental|flyingspur|ghost|phantom|wraith|dawn|ghibli|quattroporte|levante|488|f8|roma|huracan|aventador|db11|vantage;4:bentayga|cullinan|urus|dbx'],
    ['smart|смарт', 2, '2:fortwo|forfour'],
    ['mg|эмджи', 3, '2:mg5|mg6|zt|tf;3:zs|hs|mg4'],
    ['datsun|датсун', 2, '2:ondo|он-до|mi-do|mido|ми-до'],
    ['cupra|купра', 3, '2:leon|born;3:formentor|ateca'],
    ['saab|сааб', 2, '2:93|95|900|9000|93'],
    /* ---- Мото / квадро ---- */
    ['yamaha|ямаха', 0, '0:r1|r6|r3|r1m|mt07|mt09|mt03|mt10|tenere|тенере|xt|xj|fz|fzr|yzf|drag star|dragstar|virago|виrago|nmax|xmax|tmax|aerox|джог|jog|majesty|ybr|wr|yz|tw;1:grizzly|гризли|kodiak|кодиак|raptor|раптор|yfz|banshee|wolverine|волверин|rhino|носорог|viking|викинг|rmax|yxz|yxz1000|venture|sidewinder|srx'],
    ['kawasaki|кавасаки', 0, '0:ninja|ниндзя|z900|z1000|z650|zx6r|zx10r|versys|версис|vulcan|вулкан|klx|kx|er6|w800|zzr|kle;1:brute|brute force|teryx|терикс|mule|мьюл|kfx|prairie'],
    ['ktm|ктм', 0, '0:duke|дюк|adventure|адвенчер|exc|sx|rc390|rc8|superduke|690|790|890|1290'],
    ['ducati|дукати|harley|харлей|davidson|дэвидсон|triumph|триумф|royal enfield|роял энфилд|vespa|веспа|piaggio|пиаджио|aprilia|априлия|benelli|бенелли|mv agusta|moto guzzi|мото гуцци|husqvarna|хускварна|ural|урал|днепр|dnepr|bajaj|баджадж|sym|kymco|зонтес|zontes|voge|войдж|минск|minsk|иж|izh|планета|jawa|ява', 0, '0:'],
    ['polaris|поларис|снегоход', 1, '1:sportsman|спортсмен|ranger|рейнджер|rzr|рзр|scrambler|скрамблер|general|generale|индi|indy|rmk|axys|switchback|pro rmk|ace|ace'],
    ['can am|canam|can-am|кан ам|канам|brp|брп|bombardier|бомбардье|ski doo|skidoo|lynx|линкс|arctic cat|arcticcat|артик кэт', 1, '1:outlander|аутлендер|maverick|маверик|commander|коммандер|defender|renegade|ренегат|traxter|trax;0:spyder|спайдер|ryker|райкер'],
    ['cfmoto|cf moto|цфмото|сфмото', -1, '1:cforce|сфорс|zforce|зфорс|uforce|юфорс|terralander|террейнлендер|x8|x10|z8|z10|x5|u8;0:nk|mt|clx|450|650|700|800|ibex|papio'],
    ['stels|стелс|irbis|ирбис|racer|рейсер|регулмото|regulmoto|linhai|линхай|aodes|hisun|хайсан|segway|сегвей|kayo|авантис|avantis|motoland|мотоленд|wels|велс|baltmotors|балтмоторс|hammer|хаммер|armada|армада|tgb|dinli|динли|joyner|джойнер|rokon|goes|cectek|access|axl|лонсин|loncin|lonсin|zid|зид|tomahawk|томагавк', -1, '1:guepard|гепард|leopard|леопард|atv|quad|квадрик|buggy|багги;0:flame|флейм|expedition|sk|xt|sm|enduro|эндуро|cross|кросс|pitbike|питбайк']
  ];

  /* Общие слова: [класс, 'слово|слово'] */
  var GENERIC = [
    [0, 'мотоцикл|мото|скутер|мопед|питбайк|байк|мотороллер|эндуро|чоппер|круизер|motorcycle|scooter|bike|moped|cbr|ninja'],
    [1, 'квадроцикл|квадрик|атв|atv|снегоход|багги|багги|utv|ssv|snowmobile|quad|гидроцикл'],
    [2, 'седан|хэтчбек|хетчбек|универсал|купе|лифтбек|кабриолет|родстер|легковой|легковая|sedan|hatchback|wagon|coupe|лада|ваз'],
    [3, 'кроссовер|паркетник|crossover'],
    [4, 'внедорожник|джип|пикап|pickup|jeep|offroad|suv|вездеход|уаз|uaz|нива|niva|patrol|prado|крузер|гелик'],
    [5, 'минивэн|минивен|микроавтобус|фургон|газель|каблук|минибас|van|minivan|минибус|sprinter|спринтер|transit|транзит|hiace'],
    [6, 'прицеп|trailer|мзса|скиф|экспедиция|курганприцеп|тонар|лавета|причеп']
  ];

  function norm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[-_.\/]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function compactOf(s) { return norm(s).replace(/[^a-zа-я0-9]/g, ''); }
  var LOOK = { 'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x' };
  function toLat(s) { return s.replace(/[авекмнорстух]/g, function (c) { return LOOK[c]; }); }

  var BRANDS = null, GLOBAL = null;
  function build() {
    BRANDS = []; var modelClasses = {};
    DB.forEach(function (row) {
      var aliases = row[0].split('|').map(norm).filter(Boolean);
      var models = [];
      String(row[2] || '').split(';').forEach(function (grp) {
        var i = grp.indexOf(':'); if (i < 0) return;
        var cls = parseInt(grp.slice(0, i), 10);
        grp.slice(i + 1).split('|').forEach(function (m) {
          var c = compactOf(m); if (!c) return;
          models.push({ m: c, c: cls, tokenOnly: c.length <= 3 && !/\d/.test(c) });
          (modelClasses[c] = modelClasses[c] || {})[cls] = 1;
        });
      });
      models.sort(function (a, b) { return b.m.length - a.m.length; });
      BRANDS.push({ name: aliases[0], aliases: aliases, def: row[1], models: models });
    });
    GLOBAL = [];
    Object.keys(modelClasses).forEach(function (m) {
      var cl = Object.keys(modelClasses[m]);
      if (m.length >= 5 && cl.length === 1) GLOBAL.push({ m: m, c: parseInt(cl[0], 10) });
    });
    GLOBAL.sort(function (a, b) { return b.m.length - a.m.length; });
  }

  function hasModel(mm, words, comp, compLat) {
    if (mm.tokenOnly) return words.indexOf(mm.m) !== -1;
    if (comp.indexOf(mm.m) !== -1) return true;
    return /^[a-z0-9]+$/.test(mm.m) && compLat.indexOf(mm.m) !== -1;
  }

  /* Возвращает { cls: 0..6 | null, brand, model, exact } или null, если ввод пустой */
  function detect(text) {
    if (!BRANDS) build();
    var t = norm(text); if (!t) return null;
    var words = t.split(' ').filter(Boolean);
    var padded = ' ' + words.join(' ') + ' ';
    var comp = words.join(''), compLat = toLat(comp);
    var best = null, brandOnly = null, i, j;
    for (i = 0; i < BRANDS.length; i++) {
      var b = BRANDS[i], hit = b.aliases.some(function (a) { return padded.indexOf(' ' + a + ' ') !== -1; });
      if (!hit) continue;
      for (j = 0; j < b.models.length; j++) {
        if (hasModel(b.models[j], words, comp, compLat)) {
          if (!best || b.models[j].m.length > best.len) best = { cls: b.models[j].c, brand: b.name, model: b.models[j].m, len: b.models[j].m.length };
          break;
        }
      }
      if (!brandOnly && b.def >= 0) brandOnly = { cls: b.def, brand: b.name, model: null };
      if (!brandOnly) brandOnly = { cls: null, brand: b.name, model: null };
    }
    if (best) return { cls: best.cls, brand: best.brand, model: best.model, exact: true };
    for (i = 0; i < GLOBAL.length; i++) {
      if (comp.indexOf(GLOBAL[i].m) !== -1) return { cls: GLOBAL[i].c, brand: null, model: GLOBAL[i].m, exact: true };
    }
    for (i = 0; i < GENERIC.length; i++) {
      var ws = GENERIC[i][1].split('|').map(compactOf).filter(Boolean);
      for (j = 0; j < ws.length; j++) {
        var w = ws[j];
        if (w.length <= 4 ? words.indexOf(w) !== -1 : comp.indexOf(w) !== -1) return { cls: GENERIC[i][0], brand: null, model: w, exact: false };
      }
    }
    return brandOnly || { cls: null, brand: null, model: null, exact: false };
  }

  root.RLCars = { detect: detect, _db: DB };
})(window);
