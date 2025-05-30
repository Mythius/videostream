sub init()
    print "==> MainScene: init()"

    m.grid = m.top.findNode("posterGrid")
    if m.grid = invalid then
        print "==> ERROR: posterGrid not found"
        return
    end if

    m.grid.observeField("itemSelected", "onSelect")

    m.loader = m.top.findNode("loader")
    m.loader.observeField("content", "onContentLoaded")
    m.loader.url = "http://192.168.0.153/json"

    m.top.setFocus(true)
    m.grid.setFocus(true)
    
    m.video = m.top.findNode("videoPlayer")
    m.video.observeField("state", "onVideoStateChange")

    m.top.setFocus(true)
    m.grid.setFocus(true)

    ' Register key event handler
    m.top.setField("focusable", true)
    m.top.observeField("keyEvent", "onKeyEvent")

end sub

sub onContentLoaded()
    print "==> MainScene: content loaded"

    movieArray = m.loader.content
    if movieArray = invalid
        print "==> ERROR: invalid content"
        return
    end if

    contentNode = createObject("roSGNode", "ContentNode")

    for each movie in movieArray
        if movie.title <> invalid and movie.url <> invalid and movie.thumbnail <> invalid
            item = createObject("roSGNode", "ContentNode")
            item.Title = movie.title
            item.HDPosterUrl = movie.thumbnail
            item.StreamFormat = "mp4"
            item.url = movie.url  ' This can be read later for playback
            contentNode.appendChild(item)
            print "==> Added node: "; movie.title
        end if
    end for

    print "==> Setting posterGrid content with "; contentNode.getChildCount(); " items"
    m.grid.content = contentNode
end sub

sub onSelect()
    index = m.grid.itemSelected
    item = m.grid.content.getChild(index)

    print "==> onSelect: "; item.Title

    ' Hide grid
    m.grid.visible = false
    m.video.setFocus(true)


    ' Setup video
    videoNode = m.top.findNode("videoPlayer")
    if videoNode = invalid then
        print "==> ERROR: videoPlayer node not found"
        return
    end if

    ' Position video in top-right (adjust as needed for your resolution)
    videoNode.visible = true
    screenSize = CreateObject("roDeviceInfo").GetDisplaySize()
    videoNode.translation = [0, 0]
    videoNode.width = screenSize.w
    videoNode.height = screenSize.h


    contentNode = createObject("roSGNode", "ContentNode")
    contentNode.Title = item.Title
    contentNode.StreamFormat = "mp4"
    contentNode.url = item.url

    videoNode.content = contentNode
    videoNode.control = "play"
end sub


sub onVideoStateChange()
    state = m.video.state
    print "==> Video state: "; state

    if state = "finished" or state = "error"
        m.video.visible = false
        m.grid.visible = true
    end if
end sub

function onKeyEvent(key, press) as Boolean
    if press = false then return false
    if m.video.visible = false then return false

    print "==> Key pressed: "; key

    if key = "OK" or key = "Play"
        print "==> Video state: "; m.video.state
        if m.video.state = "playing"
            m.video.control = "pause"
            print "==> Sent pause command"
            return true
        else if m.video.state = "paused"
            m.video.control = "play"
            print "==> Sent play command"
            return true
        else
            print "==> State not controllable"
        end if
    else if key = "right"
        m.video.seek = m.video.position + 10
        return true
    else if key = "left"
        newPos = m.video.position - 10
        if newPos < 0 then newPos = 0
        m.video.seek = newPos
        return true
    end if

    return false
end function
