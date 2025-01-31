"use strict";{
    const { React } = HFS
    const { display } = HFS.getPluginConfig()

    HFS.onEvent('additionalEntryDetails', ({ entry }) =>
        HFS.h(Uploader, entry))

    function Uploader({ uri }) {
        const { data } = HFS.useBatch(getDetails, uri)
        const text = React.useMemo(() => {
            if (!data || data === true) return ''
            const { upload: x } = data
            return !x ? ''
                : display === 'user' ? x.username
                : display === 'ip' || !x.username ? x.ip
                : x.ip + ' (' + x.username + ')'
        }, [data])
        return text && HFS.h('span', { className: 'uploader', title: HFS.t`Uploader` },
            HFS.hIcon('upload'), ' ', text, ' – ')
    }

    function getDetails(batched) {
        return batched.length && HFS.apiCall('get_file_details', { uris: batched }).then(x => x.details)
    }

}
