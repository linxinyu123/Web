
/*页面滚动事件*/
width = 0
position = true
window.setInterval(showalert, 1);
window.onscroll = function () {
    var scrollTop = document.documentElement.scrollTop
    var opcaity = (scrollTop / 250 > 0.4) ? 0.4 : scrollTop / 250;
    document.getElementsByClassName("topBar")[0].style.background = 'rgba(255,255,255,' + opcaity + ')';
    /*if(scrollTop >= document.getElementById('id_topBar').offsetHeight ){
      
    }else{

    }*/
}
//==============================================
//document.documentElement.scrollTop　　　　　　　　滚动条移动的距离
//document.getElementById('top').offsetHeight　　导航上面top的高度。offsetHeight获取,知道固定高度的可以直接用数值代替

//document.getElementById('nav').className = 'nav navfix'　　　　.className= ，给选定的元素添加css样式
//document.getElementById('nav').className = 'nav'　
//document.getElementById('main-body').style.marginTop="40px"　　40为nav的高度，为了解决bug，也可以设置为


//其中.nav{ width:100%; height:40px; background:blue;}
//.navifx{ position：fixed; top:0px; }

function scroll_to(id) {
    var el = document.getElementById(id)
    window.scrollTo({
        top: el.offsetTop -150,
        behavior: 'smooth'
    })
}

function scroll_toTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    })
}


var card_width= (window.screen.width -600) / 3
var x = document.getElementsByClassName("card")
var i;
for(i = 0 ;i< 6;i++){
    x[i].style.width =card_width-12 + "px"
}

// portfolio
n = 0
document.getElementById("title").innerText = "石家庄藁城：赶制宫灯迎新年"
document.getElementById("a0").style.backgroundColor = "#4385f5"
function leftgo() {
        width +=200
        document.getElementById("imgs").style.marginLeft = width + "px"
}

function rightgo() {
    width -=200
    document.getElementById("imgs").style.marginLeft = width + "px"

}


           

function showalert() {
    secDiv = document.querySelector(".imgs")
secMargin = getComputedStyle(secDiv)
if (width<-1400){
    width =0
    position=true
}else if (width>0){
    width =-1400
    position=false
}else{
    if (position==true){
        width -=0.2
    }else{
        width +=0.2
    }

}
document.getElementById("imgs").style.marginLeft = width + "px"

 }
