import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Route, Routes, matchPath, useNavigate, useLocation } from 'react-router-dom';
import { Button, Drawer, Grid, Layout, Menu, Spin, Tooltip, Typography } from 'antd';
import {
  DashboardOutlined,
  BookOutlined,
  OrderedListOutlined,
  CalendarOutlined,
  SettingOutlined,
  DatabaseOutlined,
  ConsoleSqlOutlined,
  FileProtectOutlined,
  PartitionOutlined,
  CodeOutlined,
  BellOutlined,
  ApiOutlined,
  SunOutlined,
  MoonOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { Logo } from "./components/Logo";
import { useTheme } from "./theme";
import { UnsavedChangesProvider } from './components/unsaved-changes-guard';
import { BorderBeam } from './components/magicui/border-beam';
import { ConsoleCommandMenu } from './components/console-command-menu';
import { ConsoleRefreshButton } from './components/console-refresh-button';

const { Sider, Content } = Layout;
const Dashboard = lazy(() => import('./pages/Dashboard').then((page) => ({ default: page.Dashboard })));
const Books = lazy(() => import('./pages/Books').then((page) => ({ default: page.Books })));
const BookDetail = lazy(() => import('./pages/BookDetail').then((page) => ({ default: page.BookDetail })));
const Runs = lazy(() => import('./pages/Runs').then((page) => ({ default: page.Runs })));
const RunDetail = lazy(() => import('./pages/RunDetail').then((page) => ({ default: page.RunDetail })));
const Schedules = lazy(() => import('./pages/Schedules').then((page) => ({ default: page.Schedules })));
const Scripts = lazy(() => import('./pages/Scripts').then((page) => ({ default: page.Scripts })));
const ScriptWorkbench = lazy(() => import('./pages/ScriptWorkbench').then((page) => ({ default: page.ScriptWorkbench })));
const SettingsPage = lazy(() => import('./pages/Settings').then((page) => ({ default: page.Settings })));
const Database = lazy(() => import('./pages/Database').then((page) => ({ default: page.Database })));
const Schemas = lazy(() => import('./pages/Schemas').then((page) => ({ default: page.Schemas })));
const SchemaRecords = lazy(() => import('./pages/SchemaRecords').then((page) => ({ default: page.SchemaRecords })));
const Flows = lazy(() => import('./pages/Flows').then((page) => ({ default: page.Flows })));
const FlowEditor = lazy(() => import('./pages/FlowEditor').then((page) => ({ default: page.FlowEditor })));
const FlowRunDetail = lazy(() => import('./pages/FlowRunDetail').then((page) => ({ default: page.FlowRunDetail })));
const FlowRuns = lazy(() => import('./pages/FlowRunDetail').then((page) => ({ default: page.FlowRuns })));
const BrowserEvents = lazy(() => import('./pages/BrowserEvents').then((page) => ({ default: page.BrowserEvents })));
const Llm = lazy(() => import('./pages/Llm').then((page) => ({ default: page.Llm })));

/**
 * Grouped by what you came here to do, not by what the entity is called.
 *
 * Twelve flat entries meant finding a page was a matter of remembering its
 * position in the list. The four groups answer "am I watching something run,
 * building something to run, looking at what it produced, or configuring the
 * machinery" — which is the question you actually have on the way in.
 */
const menuItems = [
  {
    type: "group" as const,
    label: "运行",
    children: [
      { key: "/", icon: <DashboardOutlined aria-hidden="true" />, label: "仪表盘" },
      { key: "/runs", icon: <OrderedListOutlined aria-hidden="true" />, label: "运行记录" },
      { key: "/browser-events", icon: <BellOutlined aria-hidden="true" />, label: "事件通知" },
    ],
  },
  {
    type: "group" as const,
    label: "编排",
    children: [
      { key: "/books", icon: <BookOutlined aria-hidden="true" />, label: "Books" },
      { key: "/flows", icon: <PartitionOutlined aria-hidden="true" />, label: "流程编排" },
      { key: "/schedules", icon: <CalendarOutlined aria-hidden="true" />, label: "定时任务" },
      { key: "/scripts", icon: <CodeOutlined aria-hidden="true" />, label: "脚本库" },
    ],
  },
  {
    type: "group" as const,
    label: "数据",
    children: [
      { key: "/schemas", icon: <FileProtectOutlined aria-hidden="true" />, label: "Schema 契约" },
      { key: "/schema-records", icon: <DatabaseOutlined aria-hidden="true" />, label: "Schema 数据" },
      { key: "/database", icon: <ConsoleSqlOutlined aria-hidden="true" />, label: "数据库" },
    ],
  },
  {
    type: "group" as const,
    label: "系统",
    children: [
      { key: "/llm", icon: <ApiOutlined aria-hidden="true" />, label: "LLM 网关" },
      { key: "/settings", icon: <SettingOutlined aria-hidden="true" />, label: "设置" },
    ],
  },
];

const destinationDescriptions: Record<string, string> = {
  '/': '运行态势与关键指标', '/runs': '追踪执行结果与产物', '/browser-events': '查看通知与待处理事件',
  '/books': '管理可复用的自动化任务', '/flows': '在画布中编排自动化流程', '/schedules': '配置触发时间与执行策略', '/scripts': '编写、调试与复用脚本',
  '/schemas': '管理数据结构与契约版本', '/schema-records': '查看与整理结构化产物', '/database': '浏览数据库中的实际记录',
  '/llm': '监控模型用量与渠道健康', '/settings': '配置外观与工作空间',
};
const destinations = menuItems.flatMap(group => group.children.map(item => ({ ...item, group: group.label, description: destinationDescriptions[item.key] })));
const expandedMenuItems = menuItems.map(group => ({ ...group, children: group.children.map(item => ({ ...item, label: <span className="console-nav-label"><span>{item.label}</span><small aria-hidden="true">{destinationDescriptions[item.key]}</small></span> })) }));

export function App() {
  return <UnsavedChangesProvider><AppContent /></UnsavedChangesProvider>;
}

function AppContent() {
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [editorCollapsed, setEditorCollapsed] = useState(true);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  const screens = Grid.useBreakpoint();
  const compact = screens.md === false;
  const navigate = useNavigate();
  const location = useLocation();
  const isFlowEditor = !!matchPath('/flows/:id', location.pathname);
  const collapsed = isFlowEditor ? editorCollapsed : navigationCollapsed;
  const setCollapsed = isFlowEditor ? setEditorCollapsed : setNavigationCollapsed;
  useEffect(() => {
    if (!isFlowEditor) setEditorCollapsed(true);
  }, [isFlowEditor]);
  const { mode, toggleMode } = useTheme();

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
        event.preventDefault();
        setCommandOpen(previous => !previous);
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  // Map current path to menu key (handle /books/:id → /books)
  const pathKey = '/' + (location.pathname.split('/').filter(Boolean)[0] ?? '');
  const selectedKey = pathKey === '/flow-runs' ? '/flows' : pathKey;
  const currentGroup = menuItems.find((group) => group.children.some((item) => item.key === selectedKey));
  const currentItem = currentGroup?.children.find((item) => item.key === selectedKey);
  const detail = location.pathname !== pathKey;

  useEffect(() => {
    document.title = `${currentItem?.label ?? 'Console'} · RPA Console`;
  }, [currentItem?.label]);

  function navigateTo(key: string) {
    navigate(key);
    setMobileNavigationOpen(false);
  }

  return (
    <Layout className="console-layout console-redesigned">
      <Sider
        className="console-sidebar"
        collapsible
        collapsed={collapsed}
        width={224}
        collapsedWidth={52}
        onCollapse={setCollapsed}
        trigger={
          <button className="console-sidebar-collapse" type="button" aria-label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed}>
            {collapsed ? <MenuUnfoldOutlined /> : <><MenuFoldOutlined /><span>收起导航</span></>}
          </button>
        }
        theme="light"
        style={{
          display: compact ? 'none' : undefined,
          overflow: 'hidden',
        }}
      >
        <div className="console-brand">
          <span className="console-brand-symbol">
            <Logo size={collapsed ? 22 : 26} />
          </span>
          {!collapsed && (
            <div className="console-brand-copy">
              <Typography.Text strong className="console-brand-name" ellipsis={{ tooltip: 'RPA Console' }}>RPA Console</Typography.Text>
              <span>自动化工作空间</span>
            </div>
          )}
          <BorderBeam />
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          // Collapsed to icons there is no room for group headings, and antd
          // renders them anyway — as cramped text between the icons. Flatten.
          items={collapsed ? menuItems.flatMap((group) => group.children) : expandedMenuItems}
          onClick={({ key }) => navigateTo(key)}
        />
      </Sider>
      <Layout className="console-main">
        <header className="console-toolbar">
          <div className="console-toolbar-context">
            <Tooltip title={compact ? '打开导航' : collapsed ? '展开导航' : '收起导航'}>
              <Button
                ref={navigationTrigger}
                type="text"
                icon={compact || collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                aria-label={compact ? '打开导航' : collapsed ? '展开导航' : '收起导航'}
                aria-expanded={compact ? mobileNavigationOpen : !collapsed}
                onClick={() => compact ? setMobileNavigationOpen(true) : setCollapsed(!collapsed)}
              />
            </Tooltip>
            <nav className="console-breadcrumb" aria-label="当前位置">
              <span>{currentGroup?.label ?? '编排'}</span><span aria-hidden="true">/</span>
              <span className="console-breadcrumb-current">{currentItem?.label ?? '流程运行'}</span>
              {detail && <><span aria-hidden="true">/</span><span>{isFlowEditor || pathKey === '/scripts' ? '编辑工作区' : '详情'}</span></>}
            </nav>
          </div>
          <div className="console-toolbar-actions">
            <button type="button" className="console-command-trigger" aria-label="搜索工作区" aria-keyshortcuts="Control+k Meta+k" onClick={() => setCommandOpen(true)}><SearchOutlined aria-hidden="true" /><span>前往工作区</span><kbd>⌘ / Ctrl K</kbd></button>
            <ConsoleRefreshButton />
            <Tooltip title={mode === 'dark' ? '切换到日间模式' : '切换到夜间模式'}>
              <Button type="text" icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />} onClick={toggleMode} aria-label={mode === 'dark' ? '切换到日间模式' : '切换到夜间模式'} />
            </Tooltip>
          </div>
        </header>
        <Content
          // Dashboard, Studio and the LLM gateway provide their own full-bleed
          // layout, so they get the content area edge-to-edge instead of the
          // usual padded container.
          className={
            selectedKey === "/"
              ? "console-content console-content--dashboard"
              : selectedKey === "/database" || selectedKey === "/llm" || location.pathname.startsWith("/flows/")
                ? "console-content console-content--flush"
                : "console-content"
          }
        >
          <Suspense fallback={<div className="console-page-loading" role="status"><Spin /><span>正在加载页面…</span></div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/books" element={<Books />} />
            <Route path="/books/:id" element={<BookDetail />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/flows" element={<Flows />} />
            <Route path="/flows/:id" element={<FlowEditor />} />
            <Route path="/scripts" element={<Scripts />} />
            <Route path="/scripts/new" element={<ScriptWorkbench />} />
            <Route path="/scripts/:id" element={<ScriptWorkbench />} />
            <Route path="/flow-runs" element={<FlowRuns />} />
            <Route path="/flow-runs/:id" element={<FlowRunDetail />} />
            <Route path="/schemas" element={<Schemas />} />
            <Route path="/schema-records" element={<SchemaRecords />} />
            <Route path="/browser-events" element={<BrowserEvents />} />
            <Route path="/llm" element={<Llm />} />
            <Route path="/database" element={<Database />} />
          </Routes>
          </Suspense>
        </Content>
      </Layout>
      <Drawer
        title={<span className="console-mobile-brand"><Logo size={22} />RPA Console</span>}
        placement="left"
        width={280}
        open={compact && mobileNavigationOpen}
        onClose={() => setMobileNavigationOpen(false)}
        afterOpenChange={(open) => { if (!open) navigationTrigger.current?.focus(); }}
        className="console-navigation-drawer"
      >
        <Menu mode="inline" items={menuItems} selectedKeys={[selectedKey]} onClick={({ key }) => navigateTo(key)} />
      </Drawer>
      <ConsoleCommandMenu open={commandOpen} onClose={() => setCommandOpen(false)} destinations={destinations} onNavigate={navigateTo} />
    </Layout>
  );
}
