// products.js - 单一数据源
const NECO_DB = {
          categories: [
              { id: "classic", img: "https://dyj6gt4964deb.cloudfront.net/images/crop-5a2f691a-f7d5-4d33-b3be-b84ecea1c831.jpeg",
                title: { cn: "永远的经典", en: "Eternal Classic", pt: "Clássico Eterno" },
                desc: { cn: "黑森林 / 提拉米苏 / 红丝绒", en: "Black Forest / Tiramisu / Red Velvet", pt: "Floresta Negra / Tiramisu" } },
              { id: "layer", img: "https://dyj6gt4964deb.cloudfront.net/images/crop-0038becb-7292-4eea-93f7-9fa986281d21.jpeg",
                title: { cn: "招牌千层蛋糕", en: "Signature Layer Cake", pt: "Bolo de Mil Camadas" },
                desc: { cn: "手工制作，层层美味", en: "Handmade crepe layers", pt: "Camadas de crepe artesanais" } },
              { id: "naked", img: "https://dyj6gt4964deb.cloudfront.net/images/crop-11f1f013-ffc3-4c14-a39e-af3edc99dab8.jpeg",
                title: { cn: "原生态裸蛋糕", en: "Naked Fruit Cake", pt: "Bolo Nu" },
                desc: { cn: "新鲜水果搭配香草戚风", en: "Fresh fruits with vanilla chiffon", pt: "Frutas frescas com chiffon" } },
              { id: "cheese", img: "https://dyj6gt4964deb.cloudfront.net/images/crop-e4e9d0e4-c631-4a71-bd6a-52caa7a42fd2.jpeg",
                title: { cn: "芝士与慕斯", en: "Cheesecake & Mousse", pt: "Bolo de queijo e mousse" },
                desc: { cn: "天然食材，浓郁口感", en: "Natural ingredients", pt: "Ingredientes naturais" } },
              { id: "korean", img: "https://dyj6gt4964deb.cloudfront.net/images/crop-153de66b-9952-45d1-9c9d-09d9b1015029.jpeg",
                title: { cn: "韩式奶油调味", en: "Korean Style Cream", pt: "Estilo Coreano" },
                desc: { cn: "清新风格，独特调味", en: "Fresh style, flavored cream", pt: "Estilo fresco" } },
              { id: "custom", img: "https://dyj6gt4964deb.cloudfront.net/images/crop-0a61f906-d8d7-45b4-b0c2-c240d5b14e80.jpeg",
                title: { cn: "造型定制蛋糕", en: "Custom Design Cake", pt: "Bolo Personalizado" },
                desc: { cn: "有趣外表，好吃好玩", en: "Fun & Delicious", pt: "Divertido e delicioso" } }
          ],
          items: {
              "classic": [
                  { id:"c1", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-b267cf6d-fb4d-4d57-9351-8c69c59c54b2.jpeg",
                    title:{ cn:"红丝绒乳酪蛋糕", en:"Red Velvet Cheesecake", pt:"Cheesecake de Veludo Vermelho" },
                    desc:{
                      en:"1. Appearance: The bright red cake layer and the white cheese layer form a sharp contrast, which is very visually attractive and especially suitable for festivals and celebrations.\n2. Taste: Red velvet cake is soft and moist, and paired with the rich cheese layer, it has a delicate taste, sweet but not greasy.\n3. Flavor: Red velvet cake usually has a hint of cocoa aroma, and paired with the slightly sour cheese, the overall taste is richer.",
                      pt:"1. Aparência: As camadas de bolo vermelho vivo contrastam nitidamente com as camadas de cream cheese branco, criando um efeito visual muito atraente, especialmente adequado para feriados e celebrações.\n2. Textura: O bolo de veludo vermelho é macio e úmido, combinado com as camadas ricas de cream cheese, resultando em uma textura delicada que é doce, mas não excessivamente.\n3. Sabor: O bolo de veludo vermelho geralmente tem um leve aroma de cacau, complementado pela leve acidez do cream cheese, tornando o sabor geral mais complexo e agradável.",
                      cn:"1. 外观： 鲜艳的红色蛋糕层和白色乳酪层形成鲜明对比，视觉效果非常吸引人，特别适合节日和庆典场合。\n2. 口感： 红丝绒蛋糕柔软湿润，搭配浓郁的乳酪层，口感细腻，甜而不腻。\n3. 风味： 红丝绒蛋糕通常带有一丝可可的香气，搭配乳酪的微酸，使整体口味更加丰富。"
                    },
                    variants:[
                      { id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:42 },
                      { id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:58 }
                    ]
                  },
                  { id:"c2", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-25ad3750-4ed7-4c4f-a2cc-2d99925374a6.jpeg",
                    title:{ en:"Milk sauce black forest cake", cn:"奶酱黑森林蛋糕", pt:"Bolo floresta negra com molho de leite" },
                    desc:{
                      en:"A very rich chocolate sponge cake, with white chocolate cream, dark chocolate cream, and dark rum-stained black cherries in the middle layer. The improved Chantilly cream has a rich milky aroma. It is a classic handmade cake boutique with a blue ribbon",
                      cn:"非常浓郁的巧克力海绵蛋糕，夹层包含白巧奶油、黑巧奶油，以及黑朗姆酒渍黑樱桃，改良的香缇奶油奶香浓郁，是一款蓝带经典手工蛋糕精品",
                      pt:"Um pão de ló de chocolate muito rico com camadas de creme de chocolate branco, doce de leite de chocolate negro e cerejas pretas embebidas em rum escuro."
                    },
                    variants:[
                      { id:"v1", names:{ en:"6 inches", cn:"6寸", pt:"6 polegadas" }, price:40 },
                      { id:"v2", names:{ en:"8 inches", cn:"8寸", pt:"8 polegadas" }, price:55 }
                    ]
                  },
                  { id:"c3", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-6f9816fc-5d8f-436d-a97c-baea35005112.jpeg",
                    title:{ pt:"Tiramisu Clássico", cn:"经典提拉米苏", en:"Classic Tiramisu" },
                    desc:{
                      pt:"Um bolo tiramisu italiano muito clássico, queijo mascarpone, bolachas, café expresso líquido, feito à mão com ingredientes frescos.",
                      cn:"非常经典的意式提拉米苏蛋糕，马斯卡彭芝士、手指饼干、意式浓缩咖啡液，新鲜食材手工制作，蛋糕上的整体装饰经过我们的蛋糕师的创作，更显得唯美精致",
                      en:"Very classic Italian tiramisu cake, mascarpone cheese, ladyfingers, espresso liquid, handmade with fresh ingredients, the overall decoration on the cake is created by our baker, making it more beautiful and exquisite"
                    },
                    variants:[
                      { id:"v1", names:{ pt:"6 polegadas", cn:"6寸", en:"6 inches" }, price:38 },
                      { id:"v2", names:{ pt:"8 polegadas", cn:"8寸", en:"8 inches" }, price:49 }
                    ]
                  }
              ],
              "layer": [
                  { id:"l1", img:"https://dyj6gt4964deb.cloudfront.net/images/38db952a-2ebb-4af1-b733-a223cede14f3.jpeg",
                    title:{ cn:"巧克力千层蛋糕", en:"Chocolate Melaleuca Cake", pt:"Bolo De Melaleuca De Chocolate" },
                    desc:{
                      cn:"浓郁的巧克力可丽饼，夹层为巧克力奶油，其中还有一层巧克力慕斯，如果你热爱浓郁的巧克力风味，一定不能错过",
                      en:"Rich chocolate crepe, sandwiched with chocolate cream and a layer of chocolate mousse. If you love rich chocolate flavor, you must not miss it.",
                      pt:"Rico crepe de chocolate, prensado com creme de chocolate e uma camada de mousse de chocolate."
                    },
                    variants:[
                      { id:"v1", names:{ cn:"4英寸", en:"4 inches", pt:"4 polegadas" }, price:23 },
                      { id:"v2", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:38 },
                      { id:"v3", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:48 }
                    ]
                  },
                  { id:"l2", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-c168cd8a-0bc8-49bc-928e-0ed3239e0ac2.jpeg",
                    title:{ cn:"草莓千层蛋糕", en:"Strawberry Melaleuca Cake", pt:"Bolo De Melaleuca De Morango" },
                    desc:{ cn:"红丝绒口味的可丽饼皮，夹层为新鲜草莓熬制果酱融合白巧克力奶油，新鲜草莓点缀在蛋糕上面，口味清新独特",
                          en:"The red velvet crepe crust is sandwiched with fresh strawberry jam blended with white chocolate cream. Fresh strawberries are dotted on the cake, giving it a fresh and unique taste.",
                          pt:"Crosta de crepe com sabor a veludo vermelho, prensada com geleia de morango fresca e creme de chocolate branco, morangos frescos estão espalhados por cima do bolo e o sabor é fresco e único" },
                    variants:[
                      { id:"v1", names:{ cn:"4英寸", en:"4 inches", pt:"4 polegadas" }, price:23 },
                      { id:"v2", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:38 },
                      { id:"v3", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:48 }
                    ] },
                  { id:"l3", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-3854a4fe-b655-42f2-8521-19638e9e5d9c.jpeg",
                    title:{ cn:"抹茶千层蛋糕", en:"Matcha Melaleuca Cake", pt:"Bolo Matcha Melaleuca" },
                    desc:{ cn:"特级日本宇治抹茶粉，夹层为抹茶口味的巧克力奶油，口感细腻，层次丰富",
                          en:"Premium Japanese Uji Matcha powder, with a layer of Matcha-flavored chocolate cream, for a delicate taste and rich layers",
                          pt:"Pó Uji matcha japonês de qualidade especial, prensado com creme de chocolate com sabor a matcha, com um sabor delicado e camadas ricas" },
                    variants:[
                      { id:"v1", names:{ cn:"4英寸", en:"4 inches", pt:"4 polegadas" }, price:25 },
                      { id:"v2", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:40 },
                      { id:"v3", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:55 }
                    ] },
                  { id:"l4", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-2d13e6b9-ce8b-4516-a663-f9c90e1935ee.jpeg",
                    title:{ cn:"芒果千层蛋糕", en:"Mango Melaleuca Cake", pt:"Bolo Melaleuca De Manga" },
                    desc:{ cn:"香草口味的可丽饼，夹层包含芒果布丁和白巧奶油，点缀芒果果肉，清新爽口的夏天的感觉",
                          en:"Vanilla-flavored crepes with mango pudding and white chocolate cream in between, dotted with mango pulp, giving you a refreshing summer feel",
                          pt:"Crepe com sabor a baunilha, prensado com pudim de manga e creme de chocolate branco, embelezado com polpa de manga, refrescante sensação de verão" },
                    variants:[
                      { id:"v1", names:{ cn:"4英寸", en:"4 inches", pt:"4 polegadas" }, price:23 },
                      { id:"v2", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:36 },
                      { id:"v3", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:48 }
                    ] }
              ],
              "naked": [
                { id:"n1", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-e378d704-2d39-4765-8f46-14c5ece07b85.jpeg",
                  title:{ cn:"香草奶油水果裸蛋糕", en:"Vanilla Cream Fruit Naked Cake", pt:"Bolo Nu De Fruta Com Creme De Baunilha" },
                  desc:{ cn:"香草戚风蛋糕结合白巧克力奶油，融合草莓、蓝莓、芒果等新鲜水果。口感柔软，清爽，层次丰富，非常健康美味。",
                        en:"Vanilla chiffon cake is combined with white chocolate cream and fresh fruits such as strawberries, blueberries, and mangoes. It has a soft, refreshing texture, rich layers, and is very healthy and delicious.",
                        pt:"O bolo chiffon de baunilha combina creme de chocolate branco com morangos, mirtilos, manga e outras frutas frescas. O sabor é suave, refrescante, rico em camadas, muito saudável e delicioso." },
                  variants:[
                    { id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:32 },
                    { id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:42 }
                  ] },
                { id:"n2", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-414cc726-60e9-4bb5-a145-776fdbb67e13.jpeg",
                  title:{ cn:"抹茶青提裸蛋糕", en:"Matcha Grape Naked Cake", pt:"Bolo nu de chá verde Matcha" },
                  desc:{ cn:"抹茶青提裸蛋糕是一款非常典型的日式蛋糕。结合了清新抹茶奶油风味和爽口青提。简约自然，口感丰富多层次，清新茶香和水果融合后，充满质感和品位。",
                        en:"Matcha Grape Naked Cake is a very typical Japanese cake. It combines the fresh flavor of matcha cream and refreshing grapes. It is simple and natural, with a rich and multi-layered taste. The fusion of fresh tea fragrance and fruit is full of texture and taste.",
                        pt:"O bolo nu de chá verde Matcha é um bolo japonês muito típico. Combinando o sabor refrescante do creme matcha com as refrescantes uvas verdes. Simples e natural, o sabor é rico e multifacetado. O aroma do chá fresco e a fruta combinam-se para o tornar cheio de textura e sabor." },
                  variants:[
                    { id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:33 },
                    { id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:45 }
                  ] },
                { id:"n3", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-175c858c-f49c-4209-bfbc-a3ea7bb6a109.jpeg",
                  title:{ cn:"巧克力水果奶油裸蛋糕", en:"Chocolate Fruit Cream Naked Cake", pt:"Bolo Nu De Creme De Frutas De Chocolate" },
                  desc:{ cn:"巧克力水果奶油裸蛋糕是一款结合了巧克力的浓郁香味、奶油的丝滑口感和新鲜水果清爽风味的美味蛋糕。非常适合用于生日、婚礼、节日聚会等各种庆祝活动。",
                        en:"Chocolate Fruit Cream Naked Cake is a delicious cake that combines the rich aroma of chocolate, the smooth taste of cream and the refreshing flavor of fresh fruit. It is very suitable for various celebrations such as birthdays, weddings, holiday parties, etc.",
                        pt:"Chocolate Cream Fruit Naked Cake é um delicioso bolo que combina o rico aroma do chocolate, a textura sedosa do creme e o sabor refrescante da fruta fresca. Perfeito para diversas celebrações, como aniversários, casamentos, festas de fim de ano e muito mais." },
                  variants:[
                    { id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:33 },
                    { id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:48 }
                  ] }
              ],
              
            "cheese": [
{ id:"ch1", img:"https://dyj6gt4964deb.cloudfront.net/images/28bd1b3b-6ba5-4dd1-a6ad-9556bc81a810.jpeg",
title:{ cn:"纽约芝士蛋糕", en:"New York Cheesecake", pt:"Cheesecake de Nova Iorque" },
desc:{ cn:"芝士蛋糕中的时尚之王就是她了！", en:"She is the fashion king of cheesecake!", pt:"É a rainha da moda dos cheesecakes!" },
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:38 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:50 },
{ id:"v3", names:{ cn:"4英寸", en:"4 inches", pt:"4 polegadas" }, price:28 }
] },

{ id:"ch2",
img:"https://dyj6gt4964deb.cloudfront.net/images/crop-6054df78-55f3-4d63-8952-6530bbe00258.jpeg",
title:{
cn:"柠檬芝士蛋糕",
en:"Lemon Yogurt Mousse",
pt:"Mousse de Iogurte com Limão"
},
desc:{
cn:"新鲜柠檬制作的酸奶慕斯蛋糕，拥有非常清新的柠檬香，酸甜口味，低糖",
en:"Yogurt mousse cake made with fresh lemon has a very fresh lemon scent, sweet and sour taste, and low sugar",
pt:"Bolo de mousse de iogurte feito com limões frescos, com aroma a limão muito fresco, sabor agridoce e baixo teor de açúcar"
},
variants:[
{ id:"v1", names:{ cn:"6寸", en:"6 inches", pt:"6 polegadas" }, price:33 },
{ id:"v2", names:{ cn:"8寸", en:"8 inches", pt:"8 polegadas" }, price:45 }
]
},

{ id:"ch3",
img:"https://dyj6gt4964deb.cloudfront.net/images/crop-74f0a75c-3712-41c9-8447-5749b2f1afbd.jpeg",
title:{
cn:"焦糖慕斯蛋糕",
en:"Caramel Mousse Cake",
pt:"Bolo Mousse de Caramelo"
},
desc:{
cn:"太好吃了！",
en:"too delicious!",
pt:"delicioso demais!"
},
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:38 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:50 }
]
},

{ id:"ch4",
img:"https://dyj6gt4964deb.cloudfront.net/images/crop-bcc1aedb-728f-4895-96be-fb89ee828fb9.jpeg",
title:{
cn:"抹茶酸奶口味的漫画蛋糕",
en:"Matcha yogurt flavored cartoon cake",
pt:"Bolo manga com sabor a iogurte matcha"
},
desc:{
cn:"抹茶芝士，白巧酸奶，蓝柑慕斯三种口味层次丰富的芝士慕斯蛋糕，拥有它就像拥有了蓝天白云草地的快乐",
en:"Matcha cheese, white chocolate yogurt, blue mandarin mousse three flavors of rich cheese mousse cake, having it is like having the happiness of blue sky, white clouds and grass",
pt:"Queijo matcha, iogurte branco e mousse de tangerina azul são três sabores de bolo de mousse de queijo com camadas ricas."
},
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:38 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:50 }
]
}
              ],
                
              "korean": [
{ id:"k1", img:"https://dyj6gt4964deb.cloudfront.net/images/73898ee3-72c2-4f27-81f5-2013d579610c.jpeg",
title:{ cn:"香蕉巧克力奶油水果蛋糕", en:"Banana Chocolate Cream Fruit Cake", pt:"Bolo De Fruta Com Creme De Chocolate De Banana" },
desc:{
cn:"巧克力味道的柔软戚风蛋糕，夹层包含巧克力奶油和香蕉果泥，搭配新鲜水果，口味清爽不甜腻，是一款清爽的巧克力蛋糕",
en:"A soft chiffon cake with chocolate flavor. The interlayer contains chocolate cream and banana puree, paired with fresh fruits. It tastes refreshing and not too sweet. It is a refreshing chocolate cake.",
pt:"Bolo chiffon macio com sabor a chocolate. A sanduíche contém creme de chocolate e purê de banana."
},
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:36 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"6 polegadas" }, price:48 }
] },

{ id:"k2", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-b5f9460c-fa6b-43c2-ba0b-4c25da3ab000.jpeg",
title:{ cn:"摩卡曲奇口味奶油蛋糕", en:"Mocha Cookies Cream Cake", pt:"Bolo de creme com sabor a bolacha mocha" },
desc:{
cn:"巧克戚风软蛋糕胚，咖啡口味奶油，内加曲奇饼干，柔软又有香脆的口感",
en:"Chocolate chiffon soft cake base, coffee flavored cream, and cookies inside, soft and crispy taste",
pt:"Base de bolo macio chiffon de chocolate, creme com sabor a café, recheado com bolachas, textura macia e crocante"
},
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:36 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:48 }
] },

{ id:"k3", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-657be4a4-aad7-43b8-9418-173e475a5273.jpeg",
title:{ cn:"宇治抹茶红豆斑斓奶油蛋糕", en:"Uji Matcha Red Bean Cream Cake", pt:"Bolo de creme de feijão vermelho Uji matcha" },
desc:{
cn:"正宗宇治抹茶粉手作戚风软胚蛋糕，拥有斑斓红豆融合的白巧奶油，搭配水果装饰，清新的茶香果香红豆的甜，整体蛋糕虽然茶香浓郁，却并不苦涩，我们的抹茶材料均为日本顶级抹茶，值得尝试！",
en:"The authentic Uji Matcha powder handmade chiffon soft cake has white chocolate cream blended with colorful red beans, decorated with fruits, and has a refreshing tea aroma, fruit aroma and the sweetness of red beans. Although the overall cake has a strong tea aroma, it is not bitter. Our matcha ingredients are all top-grade Japanese matcha, it is worth a try!",
pt:"Autêntico bolo de embrião macio de chiffon feito à mão em pó Uji matcha, com creme branco fundido com feijão vermelho colorido, com decoração de frutas, aroma de chá fresco e doçura de feijão vermelho frutado. qualidade do Japão, vale a pena experimentar!"
},
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:38 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:50 }
] },

{ id:"k4", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-9b832479-e5d6-4fc4-8c7a-3f5e2983b67f.jpeg",
title:{ cn:"柠檬香缇莓果奶油蛋糕", en:"Lemon Chantilly Berry Cream Cake", pt:"Bolo de Creme de Limão Chantilly" },
desc:{
cn:"柠檬口味戚风蛋糕，夹层包含莓果果膏，白巧奶油，搭配新鲜无花果水果，这是一款风味极为出众的创意蛋糕",
en:"Lemon-flavored chiffon cake, with berry paste, white chocolate cream, and fresh figs, is a creative cake with outstanding flavor.",
pt:"Bolo chiffon com sabor a limão, prensado com pasta de frutos vermelhos, creme de chocolate branco e figo fresco."
},
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:38 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:50 }
] }
              ],
              "custom": [
{ id:"u1", img:"https://dyj6gt4964deb.cloudfront.net/images/38bf480f-d413-4b0f-af13-16ec39957a35.jpeg",
title:{ cn:"笑脸蛋糕", en:"Smiley Face Cake", pt:"Bolo de Carinha Sorridente" },
desc:{ cn:"", en:"", pt:"" },
variants:[
{ id:"v1", names:{ cn:"6英寸", en:"6 inches", pt:"6 polegadas" }, price:36 },
{ id:"v2", names:{ cn:"8英寸", en:"8 inches", pt:"8 polegadas" }, price:48 },
{ id:"v3", names:{ cn:"4英寸", en:"4 inches", pt:"4 polegadas" }, price:26 }
] },
{ id:"u2", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-59f36d43-d489-43f6-a753-fa06a9948136.jpeg",
title:{ cn:"粉色小熊梦幻蛋糕", en:"Pink Teddy Dream Cake", pt:"Bolo dos Sonhos de Ursinho Rosa" },
desc:{ cn:"", en:"", pt:"" },
variants:[
{ id:"v1", names:{ cn:"6寸", en:"6 inches", pt:"6 polegadas" }, price:43 },
{ id:"v2", names:{ cn:"8寸", en:"8 inches", pt:"8 polegadas" }, price:55 }
] },

{ id:"u3", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-f9a4ec58-a5ae-4382-9e6c-401917fb43fc.jpeg",
title:{ cn:"情侣兔子蛋糕", en:"Couple Rabbit Cake", pt:"Bolo de Coelho Casal" },
desc:{
cn:"可选口味：巧克力，柠檬，抹茶酸奶，鲜奶水果",
en:"Available flavors: chocolate, lemon, matcha yogurt, fresh milk fruit",
pt:"Sabores disponíveis: chocolate, limão, iogurte matcha, fruta fresca"
},
variants:[
{ id:"v1", names:{ cn:"4寸加高", en:"4 inches double height", pt:"4 polegadas de altura dupla" }, price:39 },
{ id:"v2", names:{ cn:"6寸加高", en:"6 inches double height", pt:"6 polegadas de altura dupla" }, price:55 }
] },
{ id:"u4", img:"https://dyj6gt4964deb.cloudfront.net/images/crop-5a8fbbb9-c8c3-4717-a4fb-8920a1182ec7.jpeg",
title:{ cn:"情侣熊蛋糕", en:"Couple Bear Cake", pt:"Bolo Casal Urso" },
desc:{
cn:"可选口味：巧克力，柠檬，抹茶酸奶，鲜奶水果",
en:"Cake flavors available: chocolate, lemon, fresh milk fruit, matcha yogurt",
pt:"Sabores de bolo disponíveis: chocolate, limão, fruta fresca, iogurte matcha"
},
variants:[
{ id:"v1", names:{ cn:"4寸加高", en:"4 inches double height", pt:"4 polegadas de altura dupla" }, price:39 },
{ id:"v2", names:{ cn:"6寸加高", en:"6 inches double height", pt:"6 polegadas de altura dupla" }, price:55 }
] }
              ]
          }
        };

// 辅助函数：根据ID查找产品（跨分类）
function findProductById(pid) {
    for (const cat in NECO_DB.items) {
        const found = NECO_DB.items[cat].find(p => p.id === pid);
        if (found) return found;
    }
    return null;
}