(function ($) {

  // Back to top script

  var btn = $('#button');

  $(window).scroll(function () {
    if ($(window).scrollTop() > 300) {
      btn.addClass('show');
    } else {
      btn.removeClass('show');
    }
  });

  btn.on('click', function (e) {
    e.preventDefault();
    $('html, body').animate({ scrollTop: 0 }, '300');
  });

  // loader

  $(window).on('load', function () {
    $('#js-preloader').addClass('loaded');
  });


  // sticky menu script

  window.onscroll = function () { myFunction() };

  var header = document.getElementById("sticky-header");
  var sticky = header.offsetTop;

  function myFunction() {
    if (window.pageYOffset > sticky) {
      header.classList.add("sticky");
    } else {
      header.classList.remove("sticky");
    }
  }

  // Counter script

  $('.count').each(function () {
    $(this).prop('Counter', 0).animate({
      Counter: $(this).text()
    }, {
      duration: 5000,
      easing: 'swing',
      step: function (now) {
        $(this).text(Math.ceil(now));
      }
    });
  });

   // slider owl script

  $('.slider').owlCarousel({
    loop: false,
    margin: 30,
    lazyLoad: true,
    nav: false,
    responsive: {
      0: {
        items: 1
      },
      600: {
        items: 1
      },
      1000: {
        items: 1
      }
    }
  });

  //blog owl script

  $('.blog').owlCarousel({
    loop: true,
    margin: 30,
    lazyLoad: true,
    nav: false,
    responsive: {
      0: {
        items: 1
      },
      600: {
        items: 2
      },
      1000: {
        items: 3
      }
    }
  });


  //testimonial owl script 

  $('.testimonial').owlCarousel({
    loop: true,
    margin: 0,
    lazyLoad: true,
    nav: false,
    responsive: {
      0: {
        items: 1
      },
      600: {
        items: 1
      },
      1000: {
        items: 1
      }
    }
  });



})(window.jQuery);