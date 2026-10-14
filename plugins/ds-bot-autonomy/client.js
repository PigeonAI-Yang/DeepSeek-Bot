window.__ModuleLoader__.load({
  id: 'ds-bot-autonomy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const h = React.createElement

    const inject = ['slots']

    function Example({ children }) {
      return h('p', {
        style: {
          margin: '6px 0 0',
          lineHeight: 1.55,
          whiteSpace: 'normal',
        },
      }, `示例：${children}`)
    }

    function UsagePage() {
      return h('section', {
        style: {
          display: 'grid',
          gap: '14px',
          padding: '16px 20px',
        },
      }, [
        h('div', { key: 'intro' }, [
          h('h2', {
            key: 'title',
            style: { margin: 0, fontSize: '18px' },
          }, '使用方法'),
          h('p', {
            key: 'description',
            style: { margin: '6px 0 0', lineHeight: 1.6 },
          }, '在 Bot 聊天中用自然语言交办，并说明目标、验收条件和允许范围。'),
        ]),
        h('ol', {
          key: 'examples',
          style: {
            display: 'grid',
            gap: '12px',
            margin: 0,
            paddingLeft: '1.25rem',
          },
        }, [
          h('li', { key: 'task' }, [
            h('h3', { key: 'title', style: { margin: '0 0 4px', fontSize: '14px' } }, '交办持续任务'),
            h(Example, { key: 'example' }, '使用自主任务整理这份资料。完成条件：回答我的三个问题并标出来源；只使用我提供的文件，最多运行 20 轮。'),
          ]),
          h('li', { key: 'progress' }, [
            h('h3', { key: 'title', style: { margin: '0 0 4px', fontSize: '14px' } }, '查看进度'),
            h(Example, { key: 'example' }, '列出我的自主任务，告诉我哪些正在执行、等待什么、还剩多少轮。'),
          ]),
          h('li', { key: 'stop-resume' }, [
            h('h3', { key: 'title', style: { margin: '0 0 4px', fontSize: '14px' } }, '停止或恢复'),
            h(Example, { key: 'stop' }, '停止刚才的自主任务。'),
            h(Example, { key: 'resume' }, '恢复这个任务，继续完成原来的目标。'),
          ]),
          h('li', { key: 'responsibility' }, [
            h('h3', { key: 'title', style: { margin: '0 0 4px', fontSize: '14px' } }, '设置长期职责'),
            h(Example, { key: 'example' }, '每天上午 9 点整理指定资料目录的新内容，汇总后保存到工作区；只处理这个目录。先为我建立职责，再绑定定时触发。'),
          ]),
          h('li', { key: 'coordination' }, [
            h('h3', { key: 'title', style: { margin: '0 0 4px', fontSize: '14px' } }, 'Bot 协作'),
            h(Example, { key: 'example' }, '把资料收集交给指定 Bot，等它返回结果后再整合并核验。'),
          ]),
          h('li', { key: 'background' }, [
            h('h3', { key: 'title', style: { margin: '0 0 4px', fontSize: '14px' } }, '边执行边回应'),
            h('p', { key: 'description', style: { margin: 0, lineHeight: 1.55 } }, '命令在原生后台任务中执行。你可以继续发消息，Bot 回应后继续原任务；后台任务完成会自动通知它。'),
            h(Example, { key: 'example' }, '继续生成图片，同时告诉我现在用的模型和进度，不要停止生成。'),
          ]),
        ]),
        h('div', { key: 'rules' }, [
          h('h3', { key: 'title', style: { margin: 0, fontSize: '14px' } }, '运行规则'),
          h('ul', {
            key: 'items',
            style: {
              display: 'grid',
              gap: '4px',
              margin: '8px 0 0',
              paddingLeft: '1.25rem',
            },
          }, [
            h('li', { key: 'rounds' }, '默认每项任务最多 20 轮，可在交办时指定。'),
            h('li', { key: 'answers' }, '需要你的答案时会等待；停止后需明确恢复。'),
            h('li', { key: 'restart' }, '重启后未完成任务保留，等待你恢复。'),
            h('li', { key: 'schedule' }, '定时工作需要 DS Bot 运行、主机保持唤醒。'),
          ]),
        ]),
      ])
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
        { name: 'plugins.bundle.config', key: 'ds-bot-autonomy' },
        UsagePage,
      ))
    }

    Object.assign(exports, { inject, apply })
    return Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: 'Module' })
  },
})
