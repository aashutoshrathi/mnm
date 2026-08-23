/**
 * words.js — the prompt bank.
 *
 * Two sources of prompts:
 *   1. Curated themes. Hand-picked, tiered 1-3 by how hard they are to draw.
 *   2. Mashups. Composed from parts (adjective x noun x action), which makes
 *      the pool effectively bottomless without padding it with junk.
 *
 * Every prompt here has passed one filter: can somebody actually draw it?
 *
 * All randomness goes through rng.js. Synced multi-device play passes its own
 * generator into mashupWord so two phones derive identical rounds offline.
 */
import { pick } from './rng.js';

const S_ = s => s.split(',');

export const THEMES = [
{id:'animals', name:'Animals', icon:'🐘', words:{
1:S_("dog,cat,elephant,penguin,shark,snail,bee,owl,frog,horse,pig,duck,spider,whale,giraffe,snake,mouse,rabbit,turtle,crab,bat,fox,cow,sheep,parrot,octopus,butterfly,squirrel,camel,jellyfish,peacock,kangaroo,hedgehog,flamingo,lobster,dolphin,tiger,monkey,chicken,goat"),
2:S_("sloth,anteater,chameleon,porcupine,walrus,pelican,armadillo,platypus,meerkat,narwhal,hummingbird,scorpion,starfish,seahorse,woodpecker,tarantula,rhinoceros,orangutan,pufferfish,dragonfly,praying mantis,king cobra,polar bear,sea turtle,stick insect,electric eel,vampire bat,honey badger,hermit crab,flying squirrel,mountain goat,arctic fox,bird of paradise,leafcutter ant,komodo dragon"),
3:S_("pack of wolves,animal migration,food chain,camouflage,hibernation,shedding skin,herding sheep,bird watching,snake charmer,dog show,animal shelter,wildlife safari,beehive,barking up the wrong tree,leading the pack,herd of elephants,swarm of bees,school of fish,predator and prey,pecking order,extinction,marine biologist,animal tracks,mating dance,nocturnal,domestication,territorial dispute,pest control,alpha wolf,taking flight")}},

{id:'food', name:'Food & Drink', icon:'🍕', words:{
1:S_("pizza,banana,egg,cupcake,sandwich,ice cream,carrot,burger,donut,noodles,watermelon,popcorn,pancakes,cheese,taco,coffee,pretzel,lollipop,corn,soup,sushi,fries,grapes,pineapple,toast,milkshake,hot dog,pie,chilli,olive,apple,bread,rice,cake,tea"),
2:S_("samosa,birthday cake,cotton candy,shaved ice,fondue,dim sum,breakfast in bed,food truck,burnt toast,leftovers,picnic basket,barbecue,ramen bowl,spice rack,rolling pin,cutting board,tea ceremony,street food,buffet,bubble tea,gingerbread house,three course meal,melting ice cream,fortune cookie,hot sauce,mystery meat,soda fountain,candy floss,pressure cooker,jar of pickles"),
3:S_("food coma,sweet tooth,brain freeze,acquired taste,comfort food,secret recipe,food poisoning,eating contest,restaurant critic,dinner party,potluck,fine dining,fast food,farm to table,recipe fail,kitchen nightmare,calorie counting,craving,fermentation,carbonation,expiration date,portion control,midnight snack,hangry,palate cleanser,meal prep,burnt offering,seconds please,table for one,split the bill")}},

{id:'house', name:'Around the House', icon:'🛋️', words:{
1:S_("chair,lamp,door,broom,clock,mirror,sock,toothbrush,pillow,kettle,ladder,bucket,hammer,scissors,umbrella,key,candle,fan,rug,shelf,soap,towel,toaster,spoon,vase,blanket,drawer,plug,mop,curtain,window,bed,sofa,fridge,bin"),
2:S_("vacuum cleaner,washing machine,ironing board,fuse box,doorbell,laundry basket,junk drawer,ceiling fan,shoe rack,step stool,fire alarm,sewing kit,tool box,welcome mat,piggy bank,jewellery box,attic,basement,garage sale,houseplant,leaky tap,squeaky door,spring cleaning,moving boxes,bunk bed,fireplace,chandelier,spare room,laundry line,cutlery drawer"),
3:S_("home makeover,housewarming,rent day,noisy neighbour,lost keys,power cut,flat pack furniture,DIY disaster,minimalism,clutter,house hunting,mortgage,roommate drama,chore chart,cabin fever,home office,open house,soundproofing,plumbing leak,home security,smart home,interior design,downsizing,hoarding,eviction notice,rewiring,thin walls,housewarming gift,landlord visit,deposit refund")}},

{id:'nature', name:'Out in Nature', icon:'🌲', words:{
1:S_("tree,cloud,mountain,river,sun,rainbow,cactus,leaf,flower,rock,moon,star,waterfall,beach,snowflake,mushroom,island,volcano,forest,wave,seashell,acorn,fog,lightning,puddle,hill,cave,desert,pond,vine,grass,seed,feather,nest,pebble"),
2:S_("sunrise,tide pool,coral reef,glacier,canyon,swamp,geyser,quicksand,sand dune,hot spring,northern lights,solar eclipse,meteor shower,tornado,hurricane,avalanche,landslide,wildfire,drought,monsoon,tree rings,spider web,anthill,honeycomb,mossy log,shooting star,crescent moon,whirlpool,tidal wave,driftwood"),
3:S_("climate change,erosion,photosynthesis,water cycle,ecosystem,gravity,seasons changing,deforestation,conservation,fossil,tectonic plates,greenhouse effect,biodiversity,pollination,natural selection,carbon footprint,renewable energy,ozone layer,food web,symbiosis,reforestation,acid rain,permafrost,coral bleaching,wilderness survival,stargazing,leave no trace,rising tide,thin air,first frost")}},

{id:'jobs', name:'Jobs & People', icon:'👷', words:{
1:S_("chef,doctor,firefighter,teacher,pilot,farmer,clown,nurse,police officer,artist,barber,mechanic,waiter,builder,dentist,singer,postman,lifeguard,judge,soldier,fisherman,plumber,cleaner,driver,baker,tailor,guard,coach,librarian,gardener,painter,vet,cashier,dancer,magician"),
2:S_("astronaut,archaeologist,detective,stunt double,tattoo artist,air traffic controller,marine biologist,news anchor,sign language interpreter,crash test dummy,street performer,beekeeper,ice sculptor,wedding planner,dog walker,ghost writer,bouncer,auctioneer,tour guide,paramedic,locksmith,cartographer,sommelier,undertaker,welder,glassblower,puppeteer,mime,lighthouse keeper,food taster"),
3:S_("job interview,promotion,resignation,burnout,office politics,team building,performance review,networking,side hustle,work from home,commute,unemployment,internship,micromanager,deadline,overtime,retirement,career change,imposter syndrome,work life balance,glass ceiling,union strike,freelancing,headhunter,elevator pitch,dress code,water cooler chat,exit interview,open plan office,notice period")}},

{id:'sport', name:'Sports & Games', icon:'⚽', words:{
1:S_("football,basketball,tennis,swimming,cycling,boxing,skiing,surfing,chess,darts,bowling,golf,skateboard,hockey,archery,karate,dancing,yoga,jump rope,kite flying,marbles,frisbee,table tennis,hopscotch,tag,hula hoop,cartwheel,arm wrestling,tug of war,juggling,cricket,running,baseball,badminton,volleyball"),
2:S_("pole vault,high jump,scuba diving,rock climbing,figure skating,synchronised swimming,bungee jumping,paragliding,horse racing,sumo wrestling,fencing,curling,triathlon,rowing,windsurfing,snowboarding,trampoline,gymnastics,rugby scrum,penalty kick,slam dunk,home run,checkmate,poker face,dodgeball,paintball,laser tag,escape room,relay baton,starting blocks"),
3:S_("home advantage,underdog,photo finish,sudden death,team spirit,fair play,doping scandal,transfer window,hat trick,offside,personal best,warm up,second wind,muscle memory,sportsmanship,rivalry,training montage,victory lap,podium finish,knockout round,tiebreaker,benchwarmer,comeback,rookie,referee decision,crowd roar,mascot,trophy cabinet,own goal,extra time")}},

{id:'travel', name:'Travel & Places', icon:'✈️', words:{
1:S_("airplane,suitcase,map,passport,train,bus,boat,hotel,bridge,tent,taxi,beach,castle,lighthouse,windmill,pyramid,igloo,harbour,tunnel,ferry,backpack,compass,camper van,ticket,street sign,fountain,market,pier,cable car,hot air balloon,road,sign post,anchor,sandcastle,postcard"),
2:S_("layover,baggage claim,duty free,border crossing,road trip,hostel dorm,night train,scenic route,traffic jam,toll booth,rest stop,customs check,cruise ship,safari jeep,mountain pass,ghost town,street market,rooftop bar,ancient ruins,pilgrimage,caravan,houseboat,tree house,capsule hotel,sleeper bus,rickshaw,gondola,funicular,hitchhiking,observation deck"),
3:S_("jet lag,culture shock,homesick,wanderlust,tourist trap,lost luggage,missed flight,travel insurance,bucket list,off the beaten path,overpacking,language barrier,currency exchange,visa application,itinerary,solo travel,backpacking,staycation,red eye flight,motion sickness,souvenir shopping,travel blogger,delayed flight,frequent flyer,digital nomad,camping trip,time zone,seat upgrade,window seat,final boarding call")}},

{id:'tech', name:'Tech & Internet', icon:'💻', words:{
1:S_("phone,laptop,headphones,camera,robot,battery,keyboard,mouse,printer,wifi,speaker,charger,drone,satellite,lightbulb,remote,antenna,cable,screen,microchip,joystick,usb stick,smartwatch,router,console,tablet,webcam,hard drive,radio,calculator,plug socket,power button,floppy disk,barcode,password"),
2:S_("video call,screen share,group chat,voice note,face unlock,dark mode,split screen,notification storm,low battery,airplane mode,cloud backup,two factor,browser tabs,autocorrect,typing indicator,read receipt,live stream,green screen,motion capture,self driving car,virtual reality,3d printer,smart fridge,fitness tracker,noise cancelling,wireless charging,solar panel,fingerprint scan,facial recognition,spam folder"),
3:S_("algorithm,firewall,open source,machine learning,doomscrolling,going viral,ghosting,catfishing,clickbait,paywall,data breach,phishing,rate limit,merge conflict,rubber duck debugging,legacy code,infinite loop,memory leak,tech debt,pair programming,code review,deployment,rollback,dark pattern,digital detox,screen time,echo chamber,filter bubble,planned obsolescence,the cloud")}},

{id:'feelings', name:'Feelings & Ideas', icon:'💭', words:{
1:S_("love,anger,sleepy,scared,happy,confused,bored,hungry,tired,excited,shy,proud,curious,relieved,panicking,calm,jealous,laughing,crying,surprised,lonely,grateful,nervous,brave,disgusted,hopeful,embarrassed,determined,peaceful,frustrated"),
2:S_("stage fright,homesick,butterflies in the stomach,cold feet,mixed signals,silent treatment,awkward silence,inside joke,pep talk,small talk,white lie,guilt trip,heartbreak,first impression,gut feeling,sixth sense,comfort zone,culture shock,peer pressure,writer's block,second thoughts,road rage,buyer's remorse,eye contact,body language,personal space,false alarm,double take,cold shoulder,pillow talk"),
3:S_("nostalgia,irony,empathy,patience,ambition,resilience,vulnerability,imposter syndrome,existential crisis,cognitive dissonance,deja vu,catharsis,denial,acceptance,forgiveness,gratitude,mindfulness,burnout,self doubt,inner critic,emotional intelligence,closure,rumination,schadenfreude,melancholy,euphoria,serenity,free will,reverse psychology,common sense")}},

{id:'actions', name:'Actions', icon:'🤸', words:{
1:S_("running,jumping,sleeping,eating,swimming,dancing,singing,reading,writing,cooking,painting,digging,climbing,falling,pushing,pulling,throwing,catching,kicking,waving,clapping,sneezing,yawning,whistling,shivering,tiptoeing,crawling,hugging,pointing,blowing,sitting,stretching,knocking,sweeping,pouring"),
2:S_("tripping over,tightrope walking,sneaking out,eavesdropping,parallel parking,threading a needle,blowing bubbles,popping balloons,skipping stones,building a sandcastle,changing a tyre,jump starting,wrapping a gift,tying shoelaces,shovelling snow,raking leaves,pitching a tent,hailing a taxi,folding laundry,chasing a bus,slipping on ice,carrying too much,squeezing through,balancing plates,untangling wires,swatting a fly,threading traffic,climbing out a window,catching a falling glass,arm wrestling"),
3:S_("procrastinating,multitasking,improvising,negotiating,celebrating,apologising,rehearsing,daydreaming,brainstorming,delegating,compromising,confessing,eloping,protesting,volunteering,mediating,speculating,auditioning,graduating,proposing,retiring,relocating,quitting,reconciling,rebelling,mentoring,evacuating,queueing,surrendering,eavesdropping badly")}},

{id:'sayings', name:'Sayings & Idioms', icon:'💬', words:{
1:S_("break the ice,spill the beans,cold feet,piece of cake,hit the sack,under the weather,raining cats and dogs,couch potato,night owl,early bird,bookworm,copycat,daredevil,scaredy cat,chatterbox,lightning fast,snail mail,bear hug,eagle eye,butterfingers,hothead,green thumb,heavy heart,big mouth,open book,tight ship,loose cannon,busy bee,top dog,cash cow"),
2:S_("bite the bullet,burn the midnight oil,cut corners,jump the gun,let the cat out of the bag,beat around the bush,on thin ice,in hot water,over the moon,under the radar,down the rabbit hole,against the clock,back to square one,between a rock and a hard place,a blessing in disguise,the last straw,the tip of the iceberg,the elephant in the room,a wild goose chase,adding fuel to the fire,killing two birds,walking on eggshells,throwing shade,pulling your leg,hitting the nail on the head,missing the boat,riding shotgun,burning bridges,rocking the boat,caught red handed"),
3:S_("the ball is in your court,don't count your chickens,the grass is always greener,a picture is worth a thousand words,actions speak louder than words,curiosity killed the cat,every cloud has a silver lining,practice makes perfect,too many cooks,when it rains it pours,you can't judge a book by its cover,bite off more than you can chew,close but no cigar,cry over spilt milk,go the extra mile,hit the ground running,ignorance is bliss,it takes two to tango,jump on the bandwagon,keep your chin up,leave no stone unturned,method to the madness,no pain no gain,once in a blue moon,the best of both worlds,through thick and thin,time flies,under lock and key,variety is the spice of life,the early bird gets the worm")}}
];

/* Mashups: composed prompts, effectively bottomless. */
const ADJ = S_("giant,tiny,angry,sleepy,melting,frozen,invisible,upside-down,haunted,glowing,exploding,soggy,ancient,robotic,inflatable,armoured,glittery,rusty,heroic,evil,polite,confused,romantic,burning,floating,underwater,edible,transparent,musical,bulletproof,cursed,royal,pixelated,origami,two-headed,talking,dancing,screaming,microscopic,bouncing,spinning,levitating,camouflaged,knitted,wooden,neon,furry,squeaky,mouldy,time-travelling");

const NOUN = S_("toaster,penguin,wizard,dentist,octopus,bicycle,volcano,librarian,pirate,cactus,robot,ghost,dragon,mailbox,astronaut,walrus,cupcake,traffic cone,grandma,ninja,vending machine,lighthouse,sock,piano,taxi,scarecrow,unicorn,burrito,submarine,gnome,barber,tornado,jellyfish,skateboard,mummy,telescope,hamster,chandelier,vampire,pineapple,lawnmower,knight,seagull,harmonica,igloo,werewolf,clown,kettle,elephant,mermaid,snowman,detective,parrot,windmill,samurai,koala,accordion,giraffe,yeti,chef,bulldozer,alien,narwhal,violin,cowboy,slot machine,flamingo,monk,tuba,raccoon,lumberjack,typewriter,sloth,wrestler,carousel,hedgehog,pharaoh,jukebox,platypus,surfer,trampoline,goblin,beekeeper,anteater,disco ball,viking,ferret,bagpipes,camel,juggler,periscope,badger,mime,catapult,peacock,shepherd,zeppelin,otter,gladiator,xylophone,moose,barista,toucan,sorcerer,waffle iron,llama,bandit,sundial,ostrich,jester,harpoon,crocodile,trebuchet,puffin,cyclops,metronome,armadillo,hitchhiker,gargoyle");

const VERB = S_("riding a bicycle,eating spaghetti,doing yoga,robbing a bank,proposing marriage,taking a selfie,teaching maths,winning a race,losing a hat,fighting a bee,baking a cake,climbing a ladder,playing chess,washing a car,walking a dog,getting a haircut,missing a bus,reading a map,painting a wall,juggling apples,skydiving,ice skating,mowing the lawn,tying shoelaces,blowing bubbles,doing laundry,fixing a pipe,delivering pizza,conducting an orchestra,escaping a cage,stuck in a chimney,waiting in the rain,at the dentist,on a first date,running late");

/**
 * Which prompt tiers each difficulty draws its three stakes from.
 * Shared by solo card dealing and synced round derivation, which must agree.
 */
export const TIER_LADDER = { easy: [1, 1, 2], medium: [1, 2, 3], hard: [2, 3, 4] };

const MASHUP = {id:'mashup', name:'Mashups', icon:'🎲', gen:true};
export const ALL_THEMES = THEMES.concat([MASHUP]);

/**
 * Compose a prompt from parts.
 * @param {number} tier 1-2 adjective+noun, 3 noun+action, 4 all three
 * @param {{pick:Function}} [rng] isolated generator; synced play passes its own
 *   so the result depends only on the round, not on module-level state
 */
export function mashupWord(tier, rng) {
  const take = rng ? rng.pick : pick;
  if (tier <= 2) return `${take(ADJ)} ${take(NOUN)}`;
  if (tier === 3) return `${take(NOUN)} ${take(VERB)}`;
  return `${take(ADJ)} ${take(NOUN)} ${take(VERB)}`;
}

/** Count of distinct prompts the bank can produce. */
export function poolSize(){
  let curated = 0;
  THEMES.forEach(t => Object.values(t.words).forEach(l => curated += l.length));
  const m2 = ADJ.length * NOUN.length;
  const m3 = NOUN.length * VERB.length;
  const m4 = ADJ.length * NOUN.length * VERB.length;
  return {curated, mashup: m2 + m3 + m4, total: curated + m2 + m3 + m4};
}
