/**
 * A small built-in kid dictionary: words that turn up in picture books and early chapter books
 * and trip up young readers. Short, friendly meanings. Admins can add a bigger offline list as
 * CONFIG_DIR/dictionary.json (see README.md); a family's own meanings beat both.
 */
const RAW = `
adventure|An exciting trip or something new and a little bit daring that you do.
afraid|Feeling scared that something bad might happen.
amazing|So good or surprising that it makes you say "wow!"
ancient|Very, very old, from a long, long time ago.
announce|To tell everyone something, out loud.
annoyed|A little bit cross because something keeps bothering you.
anxious|Worried and a bit nervous about what might happen.
astonished|Very, very surprised.
awful|Really bad.
banquet|A big, fancy meal with lots of food for lots of people.
bargain|Something you buy for less money than usual.
beast|A big, wild animal, sometimes a scary one in stories.
beneath|Under something.
blizzard|A big snowstorm with strong wind.
boast|To talk about how good you are, in a show-off way.
bold|Brave and not afraid to try things.
boulder|A very big rock.
brave|Ready to do something even when it's scary.
breeze|A soft, gentle wind.
brilliant|Very clever, or very bright and shiny.
burrow|A hole in the ground that an animal digs to live in.
cackle|A loud, sharp laugh, like a witch or a hen.
cautious|Careful, so you don't get hurt or make a mistake.
cavern|A big cave.
celebrate|To do something fun because something good happened, like a party.
cellar|A room under a house.
chuckle|A quiet little laugh.
clever|Quick at thinking and good at working things out.
clumsy|Often bumping into things or dropping them.
collapse|To fall down suddenly.
comfort|To help someone feel better when they're sad or hurt.
companion|A friend who goes along with you.
confused|Not sure what is going on.
courage|Being brave when you're scared.
crafty|Clever at tricking people.
creature|Any animal or living thing, sometimes a strange one.
crept|Moved slowly and quietly so no one would hear.
crumbs|Tiny bits that fall off bread, cake or biscuits.
curious|Wanting to know or find out about something.
dangerous|Something that could hurt you.
dash|To run somewhere very quickly.
dawn|The time in the morning when the sun comes up.
delicious|Tasting really, really good.
delighted|Very happy and pleased.
den|A wild animal's home, or a cosy hiding place.
desperate|Wanting something so much you'd try anything.
determined|Not giving up, even when it's hard.
devour|To eat something up hungrily and quickly.
disappear|To go out of sight, so you can't see it any more.
disguise|Clothes or a costume that make you look like someone else.
dusk|The time in the evening when it starts to get dark.
eager|Really wanting to do something, right now.
echo|A sound that bounces back so you hear it again.
enormous|Very, very big.
escape|To get away from somewhere you're stuck or trapped.
exhausted|Very, very tired.
explore|To look around a place to find out what's there.
fierce|Wild and angry, or very strong.
flutter|To flap quickly and lightly, like a butterfly's wings.
fond|Liking someone or something a lot.
forest|A big place with lots and lots of trees.
fortune|A lot of money, or luck.
frightened|Scared.
frown|A face you make when you're cross or worried, with your eyebrows pulled down.
furious|Very, very angry.
gasp|To breathe in suddenly because you're surprised or scared.
gentle|Kind, soft and careful.
giggle|A silly little laugh.
glare|To look at someone in an angry way.
gleam|To shine softly.
glimpse|A very quick look at something.
gloomy|Dark and a bit sad.
glow|To give out a soft, warm light.
gobble|To eat something very fast.
grateful|Feeling thankful.
greedy|Wanting more than you need, especially food or money.
grin|A big smile.
grumble|To complain in a grumpy voice.
grumpy|In a bad mood and cross.
gust|A sudden rush of wind.
hatch|When a baby animal breaks out of its egg.
haunted|A place where people say ghosts live.
hesitate|To stop for a moment before doing something, because you're not sure.
hibernate|To sleep through the whole winter, like a bear.
hollow|Empty inside, like a tree with a hole in it.
horizon|The line far away where the land or sea seems to meet the sky.
howl|A long, loud cry, like a wolf makes.
huddle|To crowd close together, often to keep warm.
hurry|To go quickly.
imagine|To make a picture of something in your mind.
immediately|Right now, straight away.
invisible|Can't be seen.
journey|A trip from one place to another.
jolly|Happy and cheerful.
kingdom|A land ruled by a king or queen.
lantern|A light you can carry, with a little case around it.
lonely|Sad because you're on your own and want a friend.
magnificent|Very beautiful, grand and impressive.
meadow|A field full of grass and flowers.
mischief|Naughty behaviour that's a little bit fun.
miserable|Very sad and unhappy.
moan|To make a long, low sound because you're hurt or unhappy, or to complain.
mumble|To speak quietly so it's hard to hear the words.
murmur|To speak very softly.
mysterious|Strange and hard to explain.
nervous|A bit worried or scared about something that's going to happen.
nibble|To take tiny bites.
nocturnal|Awake at night and asleep in the day, like an owl.
obey|To do what you're told.
ordinary|Normal, nothing special.
peculiar|Strange or unusual.
peek|To take a quick, sneaky look.
perch|To sit on the edge of something high, like a bird on a branch.
plump|Nicely round and a bit chubby.
plunge|To jump or dive into something, quickly.
pond|A small pool of water, smaller than a lake.
pounce|To jump on something suddenly to catch it.
precious|Very special and worth a lot.
prowl|To move around quietly, looking for something to catch.
puzzled|Confused because you can't work something out.
quarrel|An argument.
quiver|To shake a little bit.
rescue|To save someone from danger.
roar|A loud, deep sound, like a lion makes.
rumble|A low, rolling sound, like thunder or a hungry tummy.
rustle|A soft, crackly sound, like leaves moving.
scamper|To run with quick little steps.
scold|To tell someone off angrily.
scramble|To climb or move quickly using your hands and feet.
scurry|To run with quick, short steps, like a mouse.
shiver|To shake because you're cold or scared.
shriek|A loud, high scream.
sigh|A long breath out when you're tired, sad or relieved.
slither|To slide along the ground, like a snake.
sly|Clever in a sneaky, tricky way.
snarl|To growl and show your teeth.
sniff|To breathe in through your nose to smell something.
snooze|A short sleep.
snuggle|To curl up close and cosy.
soar|To fly high up in the sky.
sob|To cry with loud breaths.
splendid|Really wonderful.
squabble|A silly little argument.
squeak|A short, high sound, like a mouse makes.
stomp|To walk with heavy, loud steps.
stumble|To trip and nearly fall.
startled|Suddenly surprised or a little scared.
swoop|To fly down quickly, like a bird diving.
tangled|Twisted and knotted together.
terrified|Very, very scared.
thunder|The loud rumbling noise in a storm.
timid|Shy and easily scared.
trudge|To walk slowly with heavy steps because you're tired.
tumble|To fall over and roll.
twinkle|To shine with little flashes of light, like a star.
unusual|Not normal, different from what you'd expect.
vanish|To disappear suddenly.
village|A small town in the countryside.
wander|To walk around slowly without going anywhere special.
weary|Very tired.
whimper|To make small, soft crying sounds.
whisker|One of the long, stiff hairs near an animal's mouth.
whisper|To speak very quietly.
wicked|Very bad or evil.
wobble|To shake from side to side.
wonder|To think about something and ask yourself questions about it.
worried|Thinking that something bad might happen.
yawn|Opening your mouth wide when you're sleepy.
`;

export interface DictEntry {
  meaning: string;
  example?: string;
}

export const KID_WORDS: ReadonlyMap<string, DictEntry> = new Map(
  RAW.trim()
    .split("\n")
    .map((l) => l.split("|") as [string, string])
    .map(([w, m]) => [w, { meaning: m }]),
);
