const { useState, useEffect } = React;

function App() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const feedUrls = [
    "https://api.allorigins.win/raw?url=https://fenix.tecnico.ulisboa.pt/disciplinas/EMD36/2024-2025/2-semestre/rss/announcement",
    "https://api.allorigins.win/raw?url=https://fenix.tecnico.ulisboa.pt/disciplinas/CDI936/2024-2025/2-semestre/rss/announcement",
    "https://api.allorigins.win/raw?url=https://fenix.tecnico.ulisboa.pt/disciplinas/IAC236/2024-2025/2-semestre/rss/announcement"
  ];

  const extractCourseCode = (url) => {
    const match = url.match(/disciplinas\/([^/]+)/);
    return match ? match[1].toUpperCase() : "???";
  };

  useEffect(() => {
    const parser = new RSSParser();

    const fetchFeeds = async () => {
      setLoading(true);

      const promises = feedUrls.map(async (url) => {
        const courseCode = extractCourseCode(url);
        try {
          const feed = await parser.parseURL(url);
          return feed.items.map(item => ({
            title: item.title,
            link: item.link,
            pubDate: new Date(item.pubDate),
            author: item.creator || item.author || "Desconhecido",
            content: item.content || "",
            courseCode
          }));
        } catch (error) {
          console.error("Erro ao carregar:", url, error);
          return [];
        }
      });

      const results = await Promise.all(promises);
      const allItems = results.flat().sort((a, b) => b.pubDate - a.pubDate);
      setItems(allItems);
      setLoading(false);
    };

    fetchFeeds();
    const interval = setInterval(fetchFeeds, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const links = document.querySelectorAll(".content a");
    links.forEach(link => {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    });
  }, [items]);

  return React.createElement("div", { className: "container" },
    React.createElement("h1", { className: "header" }, "📢 Anúncios"),
    loading && React.createElement("p", null, "⏳ Carregando..."),
    ...items.map((item, index) =>
      React.createElement("div", { className: "card", key: index },
        React.createElement("div", { className: "tag" }, `${item.courseCode}`),
        React.createElement("h2", null,
          React.createElement("a", { href: item.link, target: "_blank", rel: "noreferrer" }, item.title)
        ),
        React.createElement("p", { className: "date" }, item.pubDate.toLocaleString()),
        React.createElement("div", {
          className: "content",
          dangerouslySetInnerHTML: { __html: item.content }
        })
      )
    )
  );
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(React.createElement(App));
